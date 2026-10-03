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
    $env:NW_ADMIN_PASSWORD.

    There is no default. The server refuses to start rather than fall back to
    a password that is published in the source, so one of these must be set.

.EXAMPLE
    .\admin\server.ps1 -Password (Read-Host 'Admin password' -AsSecureString)

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
    [string] $Root,

    [Parameter()]
    [string] $AppRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Root) {
    $Root = Split-Path -Path $PSScriptRoot -Parent
}
$Root = [System.IO.Path]::GetFullPath($Root)

# The mobile app keeps its own copy of the dataset, because a native app cannot
# read data.json out of the website folder at runtime. That copy is refreshed by
# the app's own sync script; see Sync-AppDataset for why that is wired in here.
if (-not $AppRoot) {
    $AppRoot = Join-Path (Split-Path -Path $Root -Parent) 'northwind-mobile'
}
$AppRoot = [System.IO.Path]::GetFullPath($AppRoot)
$appSyncScript = Join-Path $AppRoot 'scripts\sync-data.mjs'

# The password is held as a SecureString. Plain text is only ever read from the
# environment and is dropped as soon as it is copied.
#
# There is deliberately no built-in default. A well-known fallback is a password
# in every sense: it is in the source, it is in this repository, and anyone who
# has read either can sign in. Failing closed is the only safe default.
if (-not $Password -or $Password.Length -eq 0) {
    $plainPassword = $env:NW_ADMIN_PASSWORD
    if ([string]::IsNullOrEmpty($plainPassword)) {
        throw @'
No admin password was supplied, so the server will not start.

Choose a password, either:

    .\start-admin.cmd your-password
    powershell -File admin\server.ps1 -Password (Read-Host 'Admin password' -AsSecureString)
    $env:NW_ADMIN_PASSWORD = 'your-password'; .\admin\server.ps1

'@
    }
    $Password = New-Object System.Security.SecureString
    foreach ($character in $plainPassword.ToCharArray()) { $Password.AppendChar($character) }
    $Password.MakeReadOnly()
    $plainPassword = $null
}

$dataJsonPath = Join-Path $Root 'data.json'
$dataJsPath = Join-Path $Root 'data.js'
$sitemapScript = Join-Path $Root 'scripts\build-sitemap.mjs'
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

# Server-side scripts, shell entry points and key material are never site content,
# so they are refused whatever they are named. A blanket extension list is used
# rather than a few known filenames so that a newly added script is covered by
# default instead of needing a second edit. Anything in here returns 404, the same
# as a missing file, so nothing here advertises that it exists.
$blockedExtensions = @{
    '.ps1' = $true; '.psm1' = $true; '.psd1' = $true   # the server and its modules
    '.cmd' = $true; '.bat' = $true                       # shell entry points
    '.env' = $true; '.ini' = $true; '.config' = $true    # configuration and secrets
    '.log' = $true
    '.key' = $true; '.pem' = $true; '.pfx' = $true; '.p12' = $true; '.crt' = $true; '.cer' = $true
    '.db' = $true; '.sqlite' = $true; '.sql' = $true; '.mdb' = $true
    '.bak' = $true; '.orig' = $true; '.swp' = $true
    # Documents and infrastructure config. AGENTS.md and worker/README.md both
    # describe how the tokens, buckets and tables fit together, and wrangler.toml
    # names every binding - none of which belongs on the open web, and all of
    # which is in the repository anyway, so refusing it costs the site nothing.
    '.md' = $true; '.toml' = $true; '.yml' = $true; '.yaml' = $true; '.lock' = $true
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
    Write-Sitemap
}

# ---- sitemap.xml -----------------------------------------------------------
<#
    sitemap.xml was a hand-maintained file, and nothing in this panel knew it
    existed. Approving a listing rewrote data.json, data.js and the mobile app's
    copy - but left the sitemap listing thirteen houses when there were fourteen,
    and nothing complained. Search engines read that file as the authority on
    what is for sale, so a stale sitemap is worse than none: it looks correct.

    So it is generated here, from the same data, on the same two moments the
    other generated artifacts are written - every save, and every start.

    Like the mobile sync, this is best-effort and needs Node. A machine without
    Node still runs the panel and still publishes a correct site; it just cannot
    rebuild this one file, which is a warning rather than a failed save.
#>
function Write-Sitemap {
    if (-not (Test-Path -LiteralPath $sitemapScript -PathType Leaf)) { return }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Verbose 'Node was not found, so sitemap.xml was left alone.'
        return
    }

    try {
        $output = & $node.Source $sitemapScript 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "sitemap.xml could not be rebuilt: $output"
            return
        }
        Write-Verbose "sitemap.xml rebuilt. $output"
    } catch {
        Write-Warning "sitemap.xml could not be rebuilt: $($_.Exception.Message)"
    }
}

function Read-Data {
    $text = [System.IO.File]::ReadAllText($dataJsonPath)
    return ($text | ConvertFrom-Json)
}

function Save-Data {
    param($Data)
    # Stamp the content on every save.
    #
    # The published data.js is a *build* artifact: it only changes when someone
    # commits and Pages redeploys. Until then it can be older than a dataset an
    # editor has since changed locally, and the mobile app - which fetches it to
    # avoid shipping baked-in prices - would then walk the prices backwards. A
    # monotonic stamp lets the app compare the two copies and keep the newer one,
    # which is the whole reason this field exists. It is a plain number rather
    # than a date so a clock change cannot make a newer save look older.
    $previous = 0L
    if ($Data.site -and $Data.site.PSObject.Properties['contentVersion']) {
        [void][long]::TryParse([string]$Data.site.contentVersion, [ref]$previous)
    }
    if ($Data.site) {
        $Data.site | Add-Member -NotePropertyName 'contentVersion' `
                                 -NotePropertyValue ([string]($previous + 1)) -Force
    }

    $json = $Data | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($dataJsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-DataJs -Data $Data
    Sync-AppDataset
}

# ---- the mobile app's copy of the content ---------------------------------
<#
    The app imports its dataset at build time, so a save in the content admin
    could not reach it by itself: editing a price here used to leave the phone
    showing the old number until somebody remembered to run `npm run sync-data`.
    That is the whole reason this runs on save.

    It is deliberately best-effort. The website is the product and the app is a
    second front end for it, so a missing Node, a missing app folder or a failing
    sync is reported and then ignored rather than being allowed to fail a save
    that has already been written to disk.
#>
function Sync-AppDataset {
    if (-not (Test-Path -LiteralPath $appSyncScript -PathType Leaf)) { return }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Verbose 'Node was not found, so the mobile app dataset was left alone.'
        return
    }

    try {
        # The sync script reads data.json from the site folder passed to it, so
        # this works whatever the two folders are called or where they sit.
        $output = & $node.Source $appSyncScript $Root 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "The mobile app dataset could not be refreshed: $output"
            return
        }
        Write-Verbose "Mobile app dataset refreshed. $output"
    } catch {
        Write-Warning "The mobile app dataset could not be refreshed: $($_.Exception.Message)"
    }
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

# Ids deleted from the inbox, kept separately so a pull does not fetch an
# enquiry back after it has been deleted. Without this, deleting a spam message
# would make it reappear on the next refresh.
$removedPath = Join-Path $Root 'enquiries-removed.json'
$maxRemoved = 5000

function Read-Removed {
    if (-not (Test-Path -LiteralPath $removedPath)) { return @() }

    try {
        $text = [System.IO.File]::ReadAllText($removedPath)
        if ([string]::IsNullOrWhiteSpace($text)) { return @() }
        $parsed = $text | ConvertFrom-Json
    } catch {
        $salvage = "$removedPath.corrupt-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Warning "enquiries-removed.json could not be read; keeping a copy as $(Split-Path -Leaf $salvage) and starting a new list."
        try { [System.IO.File]::Move($removedPath, $salvage) } catch { }
        return @()
    }

    if ($parsed -is [System.Array]) { return @($parsed) }
    if ($null -ne $parsed.PSObject.Properties['removed']) { return @($parsed.removed) }
    return @()
}

function Save-Removed {
    param([string[]] $Ids)

    $json = @{ removed = @($Ids) } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($removedPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# The published site on GitHub Pages has no server, so its forms post to a
# Cloudflare Worker instead (see worker/). This server binds to loopback and
# cannot be reached from the internet, so the worker cannot push to it: the
# inbox pulls instead.
#
# Set NW_WORKER_URL to the worker's origin and NW_WORKER_TOKEN to the same
# INBOX_TOKEN given to the worker, and enquiries from the public site are
# merged into the local inbox the next time it is read. Both are optional - with
# neither set the server behaves exactly as before, serving only the enquiries
# submitted locally.
$workerUrl = $env:NW_WORKER_URL
$workerToken = $env:NW_WORKER_TOKEN
$workerTimeoutSeconds = 20

function Remove-RemoteEnquiry {
    param([string] $Id)

    if (-not $workerUrl -or -not $workerToken) { return }
    $uri = "$($workerUrl.TrimEnd('/'))/enquiry?id=$([uri]::EscapeDataString($Id))"
    try {
        $headers = @{ Authorization = "Bearer $workerToken" }
        $null = Invoke-RestMethod -Uri $uri -Method Delete -Headers $headers -TimeoutSec $workerTimeoutSeconds
    } catch {
        # Best effort only. If this fails the enquiry may come back on a later
        # pull, which is harmless next to blocking the local delete.
        Write-Warning "Could not remove enquiry $Id from the worker: $($_.Exception.Message)"
    }
}

function Sync-RemoteEnquiries {
    $store = Read-Enquiries
    $local = @($store.enquiries)
    $known = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($item in $local) { $null = $known.Add([string](Get-FieldValue $item 'id')) }
    $removed = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($id in (Read-Removed)) { $null = $removed.Add([string]$id) }

    try {
        $headers = @{ Authorization = "Bearer $workerToken" }
        $response = Invoke-RestMethod -Uri "$($workerUrl.TrimEnd('/'))/enquiries" `
            -Method Get -Headers $headers -TimeoutSec $workerTimeoutSeconds
    } catch {
        # The inbox is still readable without the worker, so a network problem
        # must not take the panel down with it.
        Write-Warning "Could not reach the enquiry worker: $($_.Exception.Message)"
        return @{ enquiries = $local }
    }

    $remote = @()
    if ($null -ne $response.PSObject.Properties['data'] -and $null -ne $response.data.PSObject.Properties['enquiries']) {
        $remote = @($response.data.enquiries)
    }

    # Oldest first, so the newest end up at the top of the inbox where the panel
    # and the local route both expect them.
    $ordered = @($remote | Sort-Object { try { [datetime]$_.createdAt } catch { [datetime]::MinValue } } -Descending)

    $added = 0
    foreach ($item in $ordered) {
        $id = [string](Get-FieldValue $item 'id')
        # No id, already held, or deleted on purpose: skip it.
        if (-not $id -or $known.Contains($id) -or $removed.Contains($id)) { continue }
        $local = @($item) + $local
        $null = $known.Add($id)
        $added++
    }

    if ($added -gt 0) {
        if ($local.Count -gt $maxEnquiries) { $local = @($local[0..($maxEnquiries - 1)]) }
        $store.enquiries = $local
        Save-Enquiries -Store $store
        # Spelled out rather than using ?: - the ternary needs PowerShell 7 and
        # this script supports 5.1.
        $noun = 'enquiries'
        if ($added -eq 1) { $noun = 'enquiry' }
        Write-Verbose "Pulled $added new $noun from the worker."
    }

    return @{ enquiries = $local }
}

function Sync-RemoteSubmissions {
    if (-not $workerUrl -or -not $workerToken) { return @() }
    try {
        $headers = @{ Authorization = "Bearer $workerToken" }
        $remote = Invoke-RestMethod -Uri "$($workerUrl.TrimEnd('/'))/office/submissions" `
            -Method Get -Headers $headers -TimeoutSec $workerTimeoutSeconds
        if ($null -ne $remote.PSObject.Properties['submissions']) { return @($remote.submissions) }
    } catch {
        Write-Warning "Could not reach the submission worker: $($_.Exception.Message)"
    }
    return @()
}

# Fetch one approved photo out of the worker's private bucket and into
# assets/homes, returning the name it was written under.
#
# The name is built here from the submission id and the photo key, never from
# anything the agent sent: the key arrives over HTTP and ends up as a path on
# this machine, so a key carrying `..` or a stray extension has to be impossible
# rather than merely unlikely. The key is validated against the shape the worker
# writes and the extension is taken from the tail of that already-checked text.
function Save-RemotePhoto {
    param([string] $WorkerUrl, [string] $WorkerToken, [string] $PhotoKey, [string] $SubmissionId)

    if ($PhotoKey -notmatch '^submissions/sub_[A-Za-z0-9_-]{1,32}/[A-Za-z0-9-]{1,64}\.(jpg|png|webp)$') {
        Write-Warning "Refusing a photo key that is not shaped like one: $PhotoKey"
        return ''
    }
    if (-not (Test-Path -LiteralPath $photoFolder)) { return '' }

    $extension = ([regex]::Match($PhotoKey, '\.(jpg|png|webp)$')).Groups[1].Value
    $stem = [System.IO.Path]::GetFileNameWithoutExtension([string]$PhotoKey)
    $safeName = ([regex]::Replace($stem, '[^A-Za-z0-9._-]', '-')) + '-' + $SubmissionId + '.' + $extension
    if (-not $safeName -or $safeName.StartsWith('.')) { return '' }

    # Fetched to memory rather than streamed to disk with -OutFile, so a failure
    # or a non-image response cannot leave a truncated file behind that the next
    # Pages build would then publish.
    $bytes = $null
    try {
        $bytes = Invoke-WebRequest -Uri "$($WorkerUrl.TrimEnd('/'))/agent/photos/$PhotoKey" `
            -Method Get -Headers @{ Authorization = "Bearer $WorkerToken" } `
            -TimeoutSec $workerTimeoutSeconds -UseBasicParsing | Select-Object -ExpandProperty Content
    } catch {
        Write-Warning "Could not fetch photo $PhotoKey : $($_.Exception.Message)"
        return ''
    }

    $raw = if ($bytes -is [byte[]]) { $bytes } else { [System.Text.Encoding]::UTF8.GetBytes([string]$bytes) }
    if (-not $raw -or $raw.Length -eq 0 -or $raw.Length -gt $maxUploadBytes) {
        Write-Warning "Photo $PhotoKey was empty or too large; skipped."
        return ''
    }

    [System.IO.File]::WriteAllBytes((Join-Path $photoFolder $safeName), $raw)
    return $safeName
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
            # Reading the inbox is also when the worker is polled, so the
            # public site's enquiries arrive without a separate step.
            if ($workerUrl -and $workerToken) {
                $data = Sync-RemoteEnquiries
            } else {
                $data = Read-Enquiries
            }
            Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; data = $data }
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

                # Remember the id, or the next pull would fetch it straight
                # back from the worker.
                $removed = [System.Collections.Generic.List[string]]::new()
                foreach ($gone in (Read-Removed)) { $removed.Add([string]$gone) }
                $removed.Add($id)
                if ($removed.Count -gt $maxRemoved) {
                    # Keep the newest ids. Read the tail into its own list
                    # first, because building a replacement while ranging over
                    # $removed would read the new, empty one.
                    $kept = [System.Collections.Generic.List[string]]::new()
                    foreach ($gone in @($removed.ToArray())[-($maxRemoved - 1)..-1]) { $kept.Add([string]$gone) }
                    $removed = $kept
                }
                Save-Removed -Ids $removed.ToArray()

                # The enquiry may have come from the worker, so take it off
                # there too. Skipped when it was submitted locally.
                Remove-RemoteEnquiry -Id $id

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
        '^/api/submissions$' {
            # Read through to the worker rather than a local file. The panel pulls,
            # for the same reason it pulls enquiries: it binds to loopback, so the
            # worker cannot reach it. Nothing is cached here either - the worker
            # holds the only copy of a submission until it is approved.
            if ($Method -ne 'GET') {
                Write-Json -Context $Context -Status 405 -Payload @{ ok = $false; error = 'Use GET.' }
                return
            }
            if (-not $workerUrl -or -not $workerToken) {
                Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; submissions = @(); configured = $false }
                return
            }
            try {
                $headers = @{ Authorization = "Bearer $workerToken" }
                $remote = Invoke-RestMethod -Uri "$($workerUrl.TrimEnd('/'))/office/submissions" `
                    -Method Get -Headers $headers -TimeoutSec $workerTimeoutSeconds
                $items = @()
                if ($null -ne $remote.PSObject.Properties['submissions']) { $items = @($remote.submissions) }
                Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; submissions = $items; configured = $true }
            } catch {
                # A worker that is down or misconfigured should leave the tab
                # readable and empty rather than take the panel down.
                Write-Warning "Could not reach the submission worker: $($_.Exception.Message)"
                Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; submissions = @(); configured = $true; warning = 'Could not reach the worker.' }
            }
        }
        '^/api/submissions/(?<sid>sub_[A-Za-z0-9_-]{1,32})/(?<verdict>approve|reject)$' {
            if ($Method -ne 'POST') {
                Write-Json -Context $Context -Status 405 -Payload @{ ok = $false; error = 'Use POST.' }
                return
            }
            if (-not $workerUrl -or -not $workerToken) {
                Write-Json -Context $Context -Status 503 -Payload @{ ok = $false; error = 'NW_WORKER_URL and NW_WORKER_TOKEN are not set.' }
                return
            }

            $sid = $Matches['sid']
            $verdict = $Matches['verdict']
            $officeHeaders = @{ Authorization = "Bearer $workerToken" }
            $body = Read-Body -Request $Context.Request
            $note = ConvertTo-PlainText (Get-FieldValue $body 'note') 400

            # Fetch the submission so the listing is written from what the agent
            # actually sent, not from whatever the panel happens to be displaying.
            try {
                $remote = Invoke-RestMethod -Uri "$($workerUrl.TrimEnd('/'))/office/submissions" `
                    -Method Get -Headers $officeHeaders -TimeoutSec $workerTimeoutSeconds
            } catch {
                Write-Json -Context $Context -Status 502 -Payload @{ ok = $false; error = 'Could not reach the worker.' }
                return
            }

            $submission = $null
            foreach ($item in @($remote.submissions)) {
                if ([string](Get-FieldValue $item 'id') -eq $sid) { $submission = $item; break }
            }
            if (-not $submission) {
                Write-Json -Context $Context -Status 404 -Payload @{ ok = $false; error = 'That submission is gone.' }
                return
            }

            if ($verdict -eq 'reject') {
                try {
                    $null = Invoke-RestMethod -Uri "$($workerUrl.TrimEnd('/'))/office/submissions/$sid/reject" `
                        -Method Post -Headers $officeHeaders -ContentType 'application/json' `
                        -Body (@{ note = $note } | ConvertTo-Json -Depth 4) -TimeoutSec $workerTimeoutSeconds
                } catch {
                    Write-Warning "Could not record the rejection: $($_.Exception.Message)"
                }
                Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; state = 'rejected' }
                return
            }

            $listing = Get-FieldValue $submission 'listing'
            if (-not $listing -or -not (Get-FieldValue $listing 'title')) {
                Write-Json -Context $Context -Status 400 -Payload @{ ok = $false; error = 'That submission has no listing in it.' }
                return
            }

            $data = Read-Data
            $listingId = [string]$submission.listingId
            if (-not $listingId) {
                # A fresh id that cannot collide with a hand-written p1/p2 listing.
                $listingId = 'a' + [guid]::NewGuid().ToString('N').Substring(0, 10)
            }
            if (@($data.listings | Where-Object { $_.id -eq $listingId }).Count -gt 0) {
                Write-Json -Context $Context -Status 409 -Payload @{ ok = $false; error = 'That submission is already on the website.' }
                return
            }

            # Photographs leave the private R2 bucket now, and only now: this is
            # the moment the listing becomes public, so this is the first moment
            # its images may sit in assets/homes, which the Pages workflow copies
            # wholesale and without review.
            $images = @()
            foreach ($key in @(Get-FieldValue $submission 'photos')) {
                if (-not $key) { continue }
                $name = Save-RemotePhoto -WorkerUrl $workerUrl -WorkerToken $workerToken `
                    -PhotoKey ([string]$key) -SubmissionId $sid
                if ($name) { $images += "assets/homes/$name" }
            }

            # The agent also becomes an agent record, so the listing's card shows
            # their name. agentFor() in app.js falls back to the first agent when
            # an id is unknown, and a stranger's name under a listing is worse.
            $agentId = ''
            if ($submission.agent) {
                $agentName = ConvertTo-PlainText (Get-FieldValue $submission.agent 'name') 80
                $agentEmail = ConvertTo-PlainText (Get-FieldValue $submission.agent 'email') 200
                $found = @($data.agents | Where-Object { $_.email -eq $agentEmail }) | Select-Object -First 1
                if ($found) {
                    $agentId = [string]$found.id
                } elseif ($agentName) {
                    $agentId = 'ag' + [guid]::NewGuid().ToString('N').Substring(0, 6)
                    $data.agents = @($data.agents) + @([ordered]@{
                        id = $agentId; name = $agentName; role = 'Agent'
                        email = $agentEmail; phone = ''; bio = ''
                    })
                }
            }

            # A listing can arrive with no photographs, so something has to stand in
            # for the card. This used to name an SVG placeholder that the website
            # no longer ships, which put a broken image on a listing the office had
            # just approved. It now takes any photograph already in the folder,
            # which is the same place the real ones live, and cannot go missing
            # without the whole site being unpublishable anyway.
            $placeholder = @('property_04_harbour_villa_twilight.jpg') |
                Where-Object { Test-Path (Join-Path $photoFolder $_) } |
                Select-Object -First 1
            if (-not $placeholder) {
                $placeholder = (Get-ChildItem $photoFolder -File -ErrorAction SilentlyContinue |
                    Select-Object -First 1).Name
            }

            $entry = [ordered]@{
                id       = $listingId
                title    = [string](Get-FieldValue $listing 'title')
                address  = [string](Get-FieldValue $listing 'address')
                city     = [string](Get-FieldValue $listing 'city')
                type     = [string](Get-FieldValue $listing 'type')
                status   = [string](Get-FieldValue $listing 'status')
                price    = [double](Get-FieldValue $listing 'price')
                beds     = [int](Get-FieldValue $listing 'beds')
                baths    = [int](Get-FieldValue $listing 'baths')
                area     = [int](Get-FieldValue $listing 'area')
                lot      = [string](Get-FieldValue $listing 'lot')
                year     = [int](Get-FieldValue $listing 'year')
                parking  = [int](Get-FieldValue $listing 'parking')
                featured = $false
                listed   = (Get-Date).ToString('yyyy-MM-dd')
                agentId  = $agentId
                image    = $(if ($images.Count -gt 0) { $images[0] } elseif ($placeholder) { "assets/homes/$placeholder" } else { '' })
                images   = $images
                features = @(Get-FieldValue $listing 'features')
                description = [string](Get-FieldValue $listing 'description')
                removedPhotos = @()
            }
            if (Get-FieldValue $listing 'land') { $entry['land'] = Get-FieldValue $listing 'land' }

            # Short stays. Copied through only when they survive the same checks the
            # worker applied on the way in, so an approval cannot be the step that
            # quietly reinstates something validation had dropped.
            #
            # `hot` is deliberately not here. Promotion is a commercial decision
            # with a date on it, and it is set in the panel below - by the office,
            # after they have looked at the listing.
            $stays = @((Get-FieldValue $listing 'stays') | Where-Object {
                $_ -in @('Nightly', 'Weekly', 'Monthly')
            })
            if ($stays.Count) {
                $entry['stays'] = @('Nightly', 'Weekly', 'Monthly' |
                    Where-Object { $_ -in $stays })

                $nightly = [double](Get-FieldValue $listing 'nightly')
                if ($nightly -gt 0) { $entry['nightly'] = [int][Math]::Round($nightly) }

                $weekly = [double](Get-FieldValue $listing 'weekly')
                if ($weekly -gt 0) { $entry['weekly'] = [int][Math]::Round($weekly) }

                $minNights = [int](Get-FieldValue $listing 'minNights')
                if ($minNights -ge 1 -and $minNights -le 365) { $entry['minNights'] = $minNights }

                $from = [string](Get-FieldValue $listing 'availableFrom')
                if ($from -match '^\d{4}-\d{2}-\d{2}$') { $entry['availableFrom'] = $from }

                $to = [string](Get-FieldValue $listing 'availableTo')
                if ($to -match '^\d{4}-\d{2}-\d{2}$') { $entry['availableTo'] = $to }

                # What a guest owes beyond the nightly rate. Capped here as well
                # as in the worker, so an approval cannot publish a figure the
                # worker would have refused.
                $deposit = [double](Get-FieldValue $listing 'deposit')
                if ($deposit -gt 0 -and $deposit -le 50000000) {
                    $entry['deposit'] = [int][Math]::Round($deposit)
                }

                $bookingFee = [double](Get-FieldValue $listing 'bookingFee')
                if ($bookingFee -gt 0 -and $bookingFee -le 1000000) {
                    $entry['bookingFee'] = [int][Math]::Round($bookingFee)
                }
            }

            $data.listings = @($data.listings) + @($entry)
            Save-Data -Data $data

            # Only now is the worker told, passing back the id the listing was
            # given - which is what links the agent's copy to the live listing.
            try {
                $null = Invoke-RestMethod -Uri "$($workerUrl.TrimEnd('/'))/office/submissions/$sid/approve" `
                    -Method Post -Headers $officeHeaders -ContentType 'application/json' `
                    -Body (@{ listingId = $listingId } | ConvertTo-Json -Depth 4) `
                    -TimeoutSec $workerTimeoutSeconds
            } catch {
                Write-Warning "The listing is live, but the worker was not told: $($_.Exception.Message)"
            }

            Write-Json -Context $Context -Status 200 -Payload @{ ok = $true; state = 'approved'; listingId = $listingId }
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
Write-Host "  Password : supplied (kept as a SecureString, never printed)" -ForegroundColor DarkGray
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

            # enquiries.json (and its salvage copies), enquiries-removed.json and
            # data.json are server-side state sitting in the web root, so the
            # static route below would hand the whole inbox to anyone who asked
            # for it without a token. 404 rather than 403, so the file simply
            # does not appear to exist.
            $fileName = [System.IO.Path]::GetFileName($path)
            if ($fileName -eq 'enquiries.json' -or $fileName -like 'enquiries.json.corrupt-*' -or
                $fileName -eq 'enquiries-removed.json' -or $fileName -like 'enquiries-removed.json.corrupt-*' -or
                $fileName -eq 'data.json') {
                $context.Response.StatusCode = 404
                $context.Response.Close()
                continue
            }

            # Anything under a dot-prefixed folder or file - .git, .runlogs, .env
            # and so on - is working state rather than site content, and is served
            # by nothing. A password or a log file left in one of those folders is
            # exactly the sort of thing that must not be reachable over HTTP, so
            # the whole class is refused here rather than one name at a time.
            if (($path.TrimStart('/') -split '/') -match '^\.') {
                $context.Response.StatusCode = 404
                $context.Response.Close()
                continue
            }

            # The worker is source code, not site content. It is the most sensitive
            # thing in the web root: lib/auth.js is the password hashing, and the
            # READMEs describe the token and bucket layout. The pages.yml workflow
            # already refuses to publish it, so this keeps the local server honest
            # about the same rule - the folder is refused whole rather than a file
            # at a time, because a new file added to it should be refused without
            # anyone remembering to extend a list.
            if (($path.TrimStart('/') -split '/') -contains 'worker') {
                $context.Response.StatusCode = 404
                $context.Response.Close()
                continue
            }

            # Same reasoning one level down: server.ps1 and friends sit inside the
            # web root, so a dot-prefix check cannot see them. Refusing the
            # extension keeps the auth logic itself from being readable.
            if ($blockedExtensions.ContainsKey([System.IO.Path]::GetExtension($path).ToLowerInvariant())) {
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
} catch {
    # Allow the listener to shut down cleanly if GetContext or request handling
    # fails outside the per-request handler.
    Write-Warning "Listener stopped: $($_.Exception.Message)"
} finally {
    $listener.Stop()
    $listener.Close()
}
