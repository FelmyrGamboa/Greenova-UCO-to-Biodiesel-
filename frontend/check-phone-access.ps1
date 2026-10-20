# Greenova: checks why a phone can't open the website, and offers to fix it.
# Run it with check-phone-access.bat (double-click), while "npm run dev" is running.
param([switch]$Fix)

$ErrorActionPreference = 'SilentlyContinue'
$Port = 8443
$RuleName = 'Greenova website'

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Good([string]$Text) { Say "  [OK]  $Text" 'Green' }
function Problem([string]$Text) { Say "  [!!]  $Text" 'Yellow' }

function Get-State {
    $s = [ordered]@{}
    $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    $s.Connected = [bool]$cfg
    if ($cfg) {
        $s.Index = $cfg.InterfaceIndex
        $s.Adapter = $cfg.InterfaceAlias
        $s.Ip = ($cfg.IPv4Address | Select-Object -First 1).IPAddress
        $net = Get-NetConnectionProfile -InterfaceIndex $cfg.InterfaceIndex | Select-Object -First 1
        $s.Network = $net.Name
        $s.Category = [string]$net.NetworkCategory
    }
    $listen = @(Get-NetTCPConnection -LocalPort $Port -State Listen)
    $s.Running = $listen.Count -gt 0
    $s.AllDevices = @($listen | Where-Object { $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' }).Count -gt 0
    $rules = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*\node.exe' } | Get-NetFirewallRule |
               Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' })
    $s.BlockRules = @($rules | Where-Object { $_.Action -eq 'Block' })
    $profileName = if ($s.Category -eq 'DomainAuthenticated') { 'Domain' } else { $s.Category }
    $allowNode = @($rules | Where-Object { $_.Action -eq 'Allow' -and (([string]$_.Profile) -eq 'Any' -or ([string]$_.Profile) -match $profileName) })
    $allowPort = @(Get-NetFirewallRule -DisplayName $RuleName | Where-Object { $_.Enabled -eq 'True' -and (([string]$_.Profile) -eq 'Any' -or ([string]$_.Profile) -match $profileName) })
    $s.Allowed = ($allowNode.Count + $allowPort.Count) -gt 0
    $s.OtherFirewalls = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName FirewallProduct | ForEach-Object { $_.displayName })
    return $s
}

function Show-State($s) {
    $issues = @()
    Say ''
    Say '  Greenova: can a phone open the website?' 'Cyan'
    Say ''
    if (-not $s.Connected) {
        Problem 'This computer is not connected to a Wi-Fi with a router (or a phone hotspot).'
        return @('offline')
    }
    Say "        Phone address: http://$($s.Ip):$Port" 'White'
    Say "        Wi-Fi / network: $($s.Network)  (adapter: $($s.Adapter))"
    Say ''

    if (-not $s.Running) {
        Problem "The website isn't running. In the frontend folder run npm run dev, then run this check again."
        $issues += 'notrunning'
    } elseif (-not $s.AllDevices) {
        Problem 'The website only accepts this computer. Start it with npm run dev (it uses --host 0.0.0.0).'
        $issues += 'localonly'
    } else {
        Good "The website is running and accepts other devices (port $Port)."
        try {
            $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://$($s.Ip):$Port/"
            Good "This computer can open http://$($s.Ip):$Port"
        } catch {
            Problem "Even this computer can't open http://$($s.Ip):$Port ($($_.Exception.Message))"
            $issues += 'selftest'
        }
    }

    if ($s.Category -eq 'Public') {
        Problem "Windows treats '$($s.Network)' as a PUBLIC network, so it blocks phones from reaching this computer."
        $issues += 'public'
    } else {
        Good "'$($s.Network)' is a $($s.Category) network."
    }

    if ($s.BlockRules.Count -gt 0) {
        Problem "Windows Firewall has $($s.BlockRules.Count) rule(s) that BLOCK Node.js (from clicking Cancel on the firewall pop-up). Block wins over allow."
        $issues += 'blocked'
    }
    if (-not $s.Allowed) {
        Problem "No firewall rule lets phones reach the website on this network."
        $issues += 'notallowed'
    } elseif ($s.BlockRules.Count -eq 0) {
        Good 'Windows Firewall allows the website.'
    }

    $others = @($s.OtherFirewalls | Where-Object { $_ -and $_ -notmatch 'Windows|Microsoft' })
    if ($others.Count -gt 0) {
        Say "        Also installed: $($others -join ', '). Its own firewall may block Node.js too; allow it there as well."
    }
    Say ''
    if ($issues.Count -eq 0) {
        Say '  Everything on this computer looks right. If the phone still cannot open it:' 'Cyan'
        Say "    1. Check the phone is on the same Wi-Fi ('$($s.Network)'), not on mobile data."
        Say '    2. School, office and public Wi-Fi often block devices from reaching each other.'
        Say "       Turn on your phone's hotspot, connect this computer to it, restart npm run dev,"
        Say '       and scan the new QR code.'
        Say "    3. Type the address exactly, starting with http:// (not https://)."
        Say ''
    }
    return $issues
}

function Repair($s) {
    if ($s.Category -eq 'Public') {
        $answer = Read-Host "  Is '$($s.Network)' your own home Wi-Fi or your phone's hotspot (not school or public Wi-Fi)? (Y/N)"
        if ($answer -match '^[Yy]') {
            Set-NetConnectionProfile -InterfaceIndex $s.Index -NetworkCategory Private
            Good "Set '$($s.Network)' to Private."
        } else {
            Say "  Left it Public. On school or public Wi-Fi, use your phone's hotspot instead." 'Yellow'
        }
    }
    if ($s.BlockRules.Count -gt 0) {
        $s.BlockRules | Remove-NetFirewallRule
        Good 'Removed the firewall rules that blocked Node.js.'
    }
    if (-not (Get-NetFirewallRule -DisplayName $RuleName)) {
        New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private, Domain | Out-Null
        Good "Added a firewall rule '$RuleName' for port $Port on private networks."
    }
}

if ($Fix) {
    Repair (Get-State)
    $null = Show-State (Get-State)
    Read-Host '  Press Enter to close'
    exit
}

$issues = Show-State (Get-State)
$fixable = @($issues | Where-Object { $_ -in @('public', 'blocked', 'notallowed') })
if ($fixable.Count -gt 0) {
    $answer = Read-Host '  Fix the firewall and network settings now? Windows will ask for administrator permission. (Y/N)'
    if ($answer -match '^[Yy]') {
        try {
            Start-Process powershell -Verb RunAs -Wait -ErrorAction Stop -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Fix"
            Say '  Done. Restart npm run dev and scan the QR code again.' 'Cyan'
        } catch {
            Say '  Not changed: administrator permission was not given.' 'Yellow'
        }
    }
}
