#Requires -Version 5.1
<#
.SYNOPSIS
    Northwind Realty — local admin backend.

.DESCRIPTION
    Serves the public site and a password-protected editing panel from one process:

        http://localhost:8001/          the public website
        http://localhost:8001/admin     the editing panel

    Content lives in data.json. Every save rewrites data.js, the static file the
    website loads, so the public site stays a plain static site that you can host
    anywhere (GitHub Pages, Netlify, S3) or open straight from disk.

    This is a single-user tool for your own machine: it binds to localhost only and
    the session token is held in memory. Do not expose this port to the internet.

.PARAMETER Port
    Port to listen on. Default 8001.

.PARAMETER Password
    Admin password, held as a SecureString so it is never kept as plain text
    in memory. Pass it a SecureString, for example
    (Read-Host 'Admin password' -AsSecureString), or leave it out and use
    $env:NW_ADMIN_PASSWORD. Defaults to $env:NW_ADMIN_PASSWORD, then
    'northwind'.

.EXAMPLE
    .\admin\server.ps1

.EXAMPLE
    .\admin\server.ps1 -Port 8080 -Password (Read-Host 'Admin password' -AsSecureString)

.EXAMPLE
    $env:NW_ADMIN_PASSWORD = 'my-secret'
    .\admin\server.ps1
#>
[CmdletBinding()]
param(
    [Parameter()]
    [ValidateRange(1024, 65535)]
    [int] $Port = 8001,

    [Parameter()]
    [SecureString] $Password,

    [Parameter()]
    [string] $Root
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Root) {
    $Root = Split-Path -Path $PSScriptRoot -Parent
}
$Root = [System.IO.Path]::GetFullPath($Root)

# The password is held as a SecureString. Plain text is only ever read from the
# environment (or the fallback below) and is dropped as soon as it is copied.
$script:UsingDefaultPassword = $false
if (-not $Password -or $Password.Length -eq 0) {
    $plainPassword = $env:NW_ADMIN_PASSWORD
    if ([string]::IsNullOrEmpty($plainPassword)) {
        $plainPassword = 'northwind'
        $script:UsingDefaultPassword = $true
    }
    $Password = New-Object System.Security.SecureString
    foreach ($character in $plainPassword.ToCharArray()) { $Password.AppendChar($character) }
    $Password.MakeReadOnly()
    $plainPassword = $null
}

$dataJsonPath = Join-Path $Root 'data.json'
$dataJsPath = Join-Path $Root 'data.js'
$adminFolder = Join-Path $Root 'admin'
$photoFolder = Join-Path $Root 'assets\homes'
$maxUploadBytes = 8MB

# Visitor messages and viewing requests live in their own file rather than in
# data.json, because /api/data rewrites data.json wholesale - anything stored
# there would be lost the next time somebody pressed Save in the content editor.
$enquiriesPath = Join-Path $Root 'enquiries.json'
$maxEnquiries = 2000

New-Item -ItemType Directory -Path $photoFolder -Force | Out-Null
if (-not (Test-Path -LiteralPath $dataJsonPath)) {
    throw "data.json was not found at '$dataJsonPath'. Run this from inside the template folder."
}

# A fresh token per run: anyone still holding yesterday's token is logged out.
$script:Token = [guid]::NewGuid().ToString('N')
$script:LastSave = (Get-Item -LiteralPath $dataJsonPath).LastWriteTime

$contentTypes = @{
    '.html'  = 'text/html; charset=utf-8'
    '.css'   = 'text/css; charset=utf-8'
    '.js'    = 'text/javascript; charset=utf-8'
    '.json'  = 'application/json; charset=utf-8'
    '.svg'   = 'image/svg+xml'
    '.png'   = 'image/png'
    '.jpg'   = 'image/jpeg'
    '.jpeg'  = 'image/jpeg'
    '.webp'  = 'image/webp'
    '.gif'   = 'image/gif'
    '.ico'   = 'image/x-icon'
    '.woff2' = 'font/woff2'
}

function Write-Json {
    param($Context, [int] $Status, $Payload)
    $json = $Payload | ConvertTo-Json -Depth 12
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Context.Response.StatusCode = $Status
    $Context.Response.ContentType = 'application/json; charset=utf-8'
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Context.Response.Close()
}

function Read-Body {
    param($Request)
    $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
    $reader.Close()
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return ($text | ConvertFrom-Json)
}

function Test-Authorized {
    param($Request)
    $header = $Request.Headers['Authorization']
    if (-not $header) { return $false }
    return ($header -eq "Bearer $($script:Token)")
}

# The expected password is never turned into a long-lived plain string: the
# SecureString is unwrapped only for the comparison below, and the byte copies
# are wiped as soon as they have been compared.
function Test-PasswordMatch {
    param([string] $Candidate, [SecureString] $Expected)

    if (-not $Expected) { return $false }

    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Expected)
    try {
        $expectedText = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }

    $expectedBytes = [System.Text.Encoding]::UTF8.GetBytes($expectedText)
    $candidateBytes = [System.Text.Encoding]::UTF8.GetBytes($Candidate)
    $expectedText = $null

    # Every byte is compared, so how long a sign-in attempt takes cannot be
    # used to work out where the two values start to differ.
    $differences = $expectedBytes.Length -bxor $candidateBytes.Length
    $length = [Math]::Max($expectedBytes.Length, $candidateBytes.Length)
    for ($index = 0; $index -lt $length; $index++) {
        $left = if ($index -lt $expectedBytes.Length) { $expectedBytes[$index] } else { 0 }
        $right = if ($index -lt $candidateBytes.Length) { $candidateBytes[$index] } else { 0 }
        $differences = $differences -bor ($left -bxor $right)
    }

    for ($index = 0; $index -lt $expectedBytes.Length; $index++) { $expectedBytes[$index] = 0 }
    for ($index = 0; $index -lt $candidateBytes.Length; $index++) { $candidateBytes[$index] = 0 }

    return ($differences -eq 0)
}

# The public site reads data.js, so keep it generated from data.json.
function Write-DataJs {
    param($Data)
    $json = $Data | ConvertTo-Json -Depth 12
    $content = "/** Generated by admin/server.ps1 from data.json - do not edit by hand. */`nconst NORTHWIND = $json;`n"
    [System.IO.File]::WriteAllText($dataJsPath, $content, (New-Object System.Text.UTF8Encoding($false)))
    $script:LastSave = (Get-Item -LiteralPath $dataJsonPath).LastWriteTime
}

function Read-Data {
    $text = [System.IO.File]::ReadAllText($dataJsonPath)
    return ($text | ConvertFrom-Json)
}

function Save-Data {
    param($Data)
    $json = $Data | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($dataJsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-DataJs -Data $Data
}

# ---- enquiries ------------------------------------------------------------
# Set-StrictMode is on, so every optional field is read through Get-FieldValue:
# touching a property ConvertFrom-Json never produced would otherwise throw.
function Get-FieldValue {
    param($Object, [string] $Name)

    if ($null -eq $Object) { return $null }
    # Indexing the collection, rather than reading .Properties.Name: member
    # enumeration throws under Set-StrictMode when the object has no properties
    # at all, which is exactly what an empty `{}` submission gives us.
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function ConvertTo-PlainText {
    param($Value, [int] $MaxLength = 2000)

    if ($null -eq $Value) { return '' }
    $text = [string]$Value
    # Strip control characters that have no business in a form field, then cap
    # the length so one very long paste cannot bloat the inbox.
    $text = ($text -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '').Trim()
    if ($text.Length -gt $MaxLength) { $text = $text.Substring(0, $MaxLength) }
    return $text
}

function Read-Enquiries {
    if (-not (Test-Path -LiteralPath $enquiriesPath)) { return @{ enquiries = @() } }

    try {
        $text = [System.IO.File]::ReadAllText($enquiriesPath)
        if ([string]::IsNullOrWhiteSpace($text)) { return @{ enquiries = @() } }
        $parsed = $text | ConvertFrom-Json
    } catch {
        # A corrupt inbox should not stop the site from serving. Keep the bad
        # file beside the new one so nothing is silently thrown away.
        $salvage = "$enquiriesPath.corrupt-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Warning "enquiries.json could not be read; keeping a copy as $(Split-Path -Leaf $salvage) and starting a new inbox."
        try { [System.IO.File]::Move($enquiriesPath, $salvage) } catch { }
        return @{ enquiries = @() }
    }

    if ($null -ne $parsed.PSObject.Properties['enquiries']) { return @{ enquiries = @($parsed.enquiries) } }
    return @{ enquiries = @() }
}

function Save-Enquiries {
    param($Store)

    $json = $Store | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($enquiriesPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Add-Enquiry {
    param($Enquiry)

    $store = Read-Enquiries
    $items = @($Enquiry) + @($store.enquiries)
    if ($items.Count -gt $maxEnquiries) { $items = @($items[0..($maxEnquiries - 1)]) }
    $store.enquiries = $items
    Save-Enquiries -Store $store
}

function New-Enquiry {
    param($Body)

    $name = ConvertTo-PlainText (Get-FieldValue $Body 'name') 120
    $email = ConvertTo-PlainText (Get-FieldValue $Body 'email') 200
    if ($email -and $email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { $email = '' }

    return [ordered]@{
        id           = 'e' + [guid]::NewGuid().ToString('N').Substring(0, 10)
        kind         = $(if ((Get-FieldValue $Body 'kind') -eq 'booking') { 'booking' } else { 'message' })
        createdAt    = (Get-Date).ToString('o')
        read         = $false
        archived     = $false
        name         = $(if ($name) { $name } else { 'Anonymous' })
        email        = $email
        phone        = (ConvertTo-PlainText (Get-FieldValue $Body 'phone') 60)
        message      = (ConvertTo-PlainText (Get-FieldValue $Body 'message') 4000)
        intent       = (ConvertTo-PlainText (Get-FieldValue $Body 'intent') 120)
        detail       = (ConvertTo-PlainText (Get-FieldValue $Body 'detail') 500)
        channel      = (ConvertTo-PlainText (Get-FieldValue $Body 'channel') 40)
        updates      = [bool](Get-FieldValue $Body 'updates')
        date         = (ConvertTo-PlainText (Get-FieldValue $Body 'date') 40)
        listingId    = (ConvertTo-PlainText (Get-FieldValue $Body 'listingId') 60)
        listingTitle = (ConvertTo-PlainText (Get-FieldValue $Body 'listingTitle') 200)
    }
}

function Send-File {
    param($Context, [string] $FilePath)

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        $Context.Response.StatusCode = 404
        $Context.Response.Close()
        return
    }

    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    $extension = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
    $Context.Response.ContentType = if ($contentTypes.ContainsKey($extension)) { $contentTypes[$extension] } else { 'application/octet-stream' }
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.Headers['Cache-Control'] = 'no-store'
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Context.Response.Close()
}

function Resolve-SafePath {
    param([string] $RelativePath)

    $clean = ($RelativePath -replace '^[/\\]+', '').Trim()
    if (-not $clean) { return $Root }

    $candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $clean))
    if (-not $candidate.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    return $candidate
}

# ---- API ------------------------------------------------------------------
function Invoke-Api {
    param($Context, [string] $Path, [string] $Method)

    if ($Path -eq '/api/login' -and $Method -eq 'POST') {
        $body = Read-Body -Request $Context.Request
        if ($body -and (Test-PasswordMatch -Candidate $body.password -Expected $Password)) {
            Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; token = $script:Token }
        } else {
            Write-Json -Context $Context -Status 401 -Payload @{ ok = $false; error = 'That password is not right.' }
        }
        return
    }

    # The enquiry endpoint is public on purpose: it is the public website's own
    # forms posting to us. It only ever appends, accepts no token and can never
    # read the inbox back, so it sits above the admin authorisation check.
    if ($Path -eq '/api/enquiry' -and $Method -eq 'POST') {
        $body = Read-Body -Request $Context.Request
        # A real check for a JSON object, not `-isnot [psobject]`: PowerShell wraps
        # every value in a PSObject, so that test is never true and a bare string
        # or array body would sail straight through.
        if ($body -isnot [System.Management.Automation.PSCustomObject]) {
            Write-Json -Context $Context -Status 400 -Payload @{ ok = $false; error = 'The form was empty.' }
            return
        }

        $name = ConvertTo-PlainText (Get-FieldValue $body 'name') 120
        $email = ConvertTo-PlainText (Get-FieldValue $body 'email') 200
        $phone = ConvertTo-PlainText (Get-FieldValue $body 'phone') 60
        if (-not $name -and -not $email -and -not $phone) {
            Write-Json -Context $Context -Status 400 -Payload @{ ok = $false; error = 'The form was empty.' }
            return
        }
        # A note with no way to reply to it is not worth keeping.
        if ($name -and -not $email -and -not $phone) {
            Write-Json -Context $Context -Status 400 -Payload @{ ok = $false; error = 'Please give an email address or a phone number so we can reply.' }
            return
        }

        $enquiry = New-Enquiry -Body $body
        Add-Enquiry -Enquiry $enquiry
        Write-Json -Context $Context -Status 201 -Payload @{ ok = $true; id = $enquiry.id }
        return
    }

    if (-not (Test-Authorized -Request $Context.Request)) {
        Write-Json -Context $Context -Status 401 -Payload @{ ok = $false; error = 'Please sign in again.' }
        return
    }

    switch -Regex ($Path) {
        '^/api/state$' {
            Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; data = (Read-Data) }
        }
        '^/api/enquiries$' {
            Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; data = (Read-Enquiries) }
        }
        '^/api/enquiry$' {
            $body = Read-Body -Request $Context.Request
            $id = ConvertTo-PlainText (Get-FieldValue $body 'id') 60
            if (-not $id) {
                Write-Json -Context $Context -Status 400 -Payload @{ ok = $false; error = 'Which enquiry?' }
                return
            }

            $store = Read-Enquiries
            $items = @($store.enquiries)
            $index = -1
            for ($i = 0; $i -lt $items.Count; $i++) {
                if ((Get-FieldValue $items[$i] 'id') -eq $id) { $index = $i; break }
            }
            if ($index -eq -1) {
                Write-Json -Context $Context -Status 404 -Payload @{ ok = $false; error = 'That enquiry is no longer there.' }
                return
            }

            if ($Method -eq 'DELETE') {
                $store.enquiries = @($items | Where-Object { (Get-FieldValue $_ 'id') -ne $id })
                Save-Enquiries -Store $store
                Write-Json -Context $Context -Status 200 -Payload @{ ok = $true }
                return
            }
            if ($Method -ne 'PATCH') {
                Write-Json -Context $Context -Status 405 -Payload @{ ok = $false; error = 'Use PATCH or DELETE.' }
                return
            }

            $item = $items[$index]
            if ((Get-FieldValue $body 'read') -is [bool]) { $item.read = [bool](Get-FieldValue $body 'read') }
            if ((Get-FieldValue $body 'archived') -is [bool]) { $item.archived = [bool](Get-FieldValue $body 'archived') }
            $items[$index] = $item
            $store.enquiries = $items
            Save-Enquiries -Store $store
            Write-Json -Context $Context -Status 200 -Payload @{ ok = $true }
        }
        '^/api/data$' {
            if ($Method -ne 'PUT') {
                Write-Json -Context $Context -Status 405 -Payload @{ ok = $false; error = 'Use PUT.' }
                return
            }
            $body = Read-Body -Request $Context.Request
            if (-not $body.site -or -not $body.listings) {
                Write-Json -Context $Context -Status 400 -Payload @{ ok = $false; error = 'The payload was missing site or listings.' }
                return
            }
            $ids = @($body.listings | ForEach-Object { $_.id } | Where-Object { $_ })
            if (($ids | Select-Object -Unique).Count -ne $ids.Count) {
                Write-Json -Context $Context -Status 400 -Payload @{ ok = $false; error = 'Two listings share the same id.' }
                return
            }
            Save-Data -Data $body
            Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; savedAt = (Get-Date).ToString('s') }
        }
        '^/api/photo$' {
            if ($Method -eq 'DELETE') {
                $body = Read-Body -Request $Context.Request
                $target = Resolve-SafePath -RelativePath ([string]$body.path)
                $photoRoot = [System.IO.Path]::GetFullPath($photoFolder)
                if ($target -and $target.StartsWith($photoRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $target)) {
                    Remove-Item -LiteralPath $target -Force
                    Write-Json -Context $Context -Status 200 -Payload @{ ok = $true }
                } else {
                    Write-Json -Context $Context -Status 404 -Payload @{ ok = $false; error = 'That image was not found.' }
                }
                return
            }

            $body = Read-Body -Request $Context.Request
            $safeName = [System.IO.Path]::GetFileName([string]$body.name) -replace '[^A-Za-z0-9._-]', '-'
            if (-not $safeName -or $safeName -eq '.') { $safeName = 'photo.png' }
            if ($safeName -notmatch '\.(png|jpe?g|webp|gif|svg)$') { $safeName = [System.IO.Path]::ChangeExtension($safeName, '.jpg') }

            $dataUrl = [string]$body.dataUrl
            $commaIndex = $dataUrl.IndexOf(',')
            if ($commaIndex -lt 1) {
                Write-Json -Context $Context -Status 400 -Payload @{ ok = $false; error = 'The image data was empty.' }
                return
            }
            try {
                $bytes = [Convert]::FromBase64String($dataUrl.Substring($commaIndex + 1))
            } catch {
                Write-Json -Context $Context -Status 400 -Payload @{ ok = $false; error = 'The image could not be decoded.' }
                return
            }
            if ($bytes.Length -gt $maxUploadBytes) {
                Write-Json -Context $Context -Status 413 -Payload @{ ok = $false; error = 'Images must be under 8 MB.' }
                return
            }

            [System.IO.File]::WriteAllBytes((Join-Path $photoFolder $safeName), $bytes)
            Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; path = "assets/homes/$safeName" }
        }
        '^/api/export$' {
            Send-File -Context $Context -FilePath $dataJsonPath
        }
        default {
            Write-Json -Context $Context -Status 404 -Payload @{ ok = $false; error = 'Unknown endpoint.' }
        }
    }
}

# ---- listener -------------------------------------------------------------
# Keep the static data.js in step with data.json on every start.
Write-DataJs -Data (Read-Data)

$listener = New-Object System.Net.HttpListener
# HttpListener matches on the Host header, not the socket, so registering only
# "localhost" makes http://127.0.0.1:port/ fail with 400 Bad Request. Register
# the loopback spellings too, best-effort: a name that needs an elevated URL ACL
# reservation is skipped rather than stopping the server from starting.
$hostNames = @('localhost', '127.0.0.1', '[::1]')
$bound = @()
foreach ($hostName in $hostNames) {
    try {
        $listener.Prefixes.Add("http://$hostName`:$Port/")
        $bound += $hostName
    } catch {
        Write-Warning "Could not listen on $hostName`:$Port - $($_.Exception.Message)"
    }
}
if (-not $bound) { throw "None of the loopback addresses could be bound on port $Port." }

Write-Host ''
Write-Host '  Northwind Realty - admin backend' -ForegroundColor Green
foreach ($hostName in $bound) {
    Write-Host "  Website : http://$hostName`:$Port/" -ForegroundColor Cyan
    Write-Host "  Admin   : http://$hostName`:$Port/admin" -ForegroundColor Cyan
}
Write-Host "  Password: $(if ($script:UsingDefaultPassword) { 'northwind  (change it with -Password or $env:NW_ADMIN_PASSWORD)' } else { '(custom)' })" -ForegroundColor DarkGray
Write-Host '  Ctrl+C to stop' -ForegroundColor DarkGray
Write-Host ''

$listener.Start()

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $path = $context.Request.Url.AbsolutePath
        $method = $context.Request.HttpMethod

        try {
            if ($path.StartsWith('/api/')) {
                Invoke-Api -Context $context -Path $path -Method $method
                continue
            }

            # /admin has to redirect to /admin/, otherwise the browser reads the
            # page's relative admin.css and admin.js as /admin.css and /admin.js
            # and the panel arrives with no styles and no script.
            if ($path -eq '/admin') {
                $context.Response.StatusCode = 302
                $context.Response.Headers['Location'] = '/admin/'
                $context.Response.Close()
                continue
            }

            if ($path -eq '/admin/' -or $path -eq '/admin/index.html') {
                Send-File -Context $context -FilePath (Join-Path $adminFolder 'index.html')
                continue
            }

            # enquiries.json (and its salvage copies) and data.json are server-side
            # state sitting in the web root, so the static route below would hand
            # the whole inbox to anyone who asked for it without a token. 404
            # rather than 403, so the file simply does not appear to exist.
            $fileName = [System.IO.Path]::GetFileName($path)
            if ($fileName -eq 'enquiries.json' -or $fileName -like 'enquiries.json.corrupt-*' -or $fileName -eq 'data.json') {
                $context.Response.StatusCode = 404
                $context.Response.Close()
                continue
            }

            $asset = Resolve-SafePath -RelativePath $path
            if (-not $asset) {
                $context.Response.StatusCode = 403
                $context.Response.Close()
                continue
            }
            if (Test-Path -LiteralPath $asset -PathType Container) {
                $indexFile = Join-Path $asset 'index.html'
                if (Test-Path -LiteralPath $indexFile -PathType Leaf) { $asset = $indexFile }
            }
            Send-File -Context $context -FilePath $asset
        } catch {
            Write-Warning "Request failed for $path : $($_.Exception.Message)"
            try { $context.Response.StatusCode = 500; $context.Response.Close() } catch { }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
