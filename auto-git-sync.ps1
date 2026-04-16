param(
  [string]$RepoPath = ".",
  [string]$Branch = "main",
  [int]$PollSeconds = 5,
  [int]$DebounceSeconds = 20,
  [string]$CommitPrefix = "chore: auto sync"
)

$ErrorActionPreference = "Stop"

function Write-Log([string]$Message) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Output "[$ts] $Message"
}

function Get-TrackedChanges([string]$Path) {
  Set-Location $Path
  $raw = git status --porcelain
  if (-not $raw) { return @() }

  $lines = @($raw -split "`r?`n" | Where-Object { $_ -and $_.Trim() -ne "" })
  if (-not $lines) { return @() }

  $filtered = @()
  foreach ($line in $lines) {
    if ($line.Length -lt 4) { continue }
    $file = $line.Substring(3).Trim()

    if ($file -like ".git/*") { continue }
    if ($file -like "venv/*" -or $file -eq "venv") { continue }
    if ($file -like ".venv/*" -or $file -eq ".venv") { continue }
    if ($file -like "__pycache__/*" -or $file -eq "__pycache__") { continue }
    if ($file -like ".vscode/*" -or $file -eq ".vscode") { continue }
    if ($file -eq "portal.local.db" -or $file -like "*.sqlite" -or $file -like "*.sqlite3" -or $file -like "*.local.db") { continue }

    $filtered += $line
  }

  return $filtered
}

function Sync-Now([string]$Path, [string]$TargetBranch, [string]$Prefix) {
  Set-Location $Path

  # Adiciona tudo (respeitando .gitignore)
  git add -A | Out-Null

  $postAdd = git status --porcelain
  if (-not $postAdd) {
    Write-Log "Sem alteracoes para commit."
    return
  }

  $message = "$Prefix $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  git commit -m $message | Out-Null
  git push origin $TargetBranch | Out-Null

  Write-Log "Sync concluido: commit + push em '$TargetBranch'."
}

try {
  Set-Location $RepoPath
  git rev-parse --is-inside-work-tree | Out-Null
} catch {
  Write-Error "Repositorio Git invalido em: $RepoPath"
  exit 1
}

Write-Log "Auto Git Sync iniciado em '$RepoPath' (branch: $Branch)."
Write-Log "Debounce: $DebounceSeconds s | Poll: $PollSeconds s"
Write-Log "Pare com Ctrl+C"

$lastFingerprint = ""
$pendingSince = $null

while ($true) {
  try {
    $changes = Get-TrackedChanges -Path $RepoPath
    $fingerprint = ($changes -join "`n")

    if ([string]::IsNullOrWhiteSpace($fingerprint)) {
      $lastFingerprint = ""
      $pendingSince = $null
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    if ($fingerprint -ne $lastFingerprint) {
      $lastFingerprint = $fingerprint
      $pendingSince = Get-Date
      Write-Log "Alteracao detectada. Aguardando estabilizar..."
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    if ($pendingSince -ne $null) {
      $elapsed = (New-TimeSpan -Start $pendingSince -End (Get-Date)).TotalSeconds
      if ($elapsed -ge $DebounceSeconds) {
        Sync-Now -Path $RepoPath -TargetBranch $Branch -Prefix $CommitPrefix
        $lastFingerprint = ""
        $pendingSince = $null
      }
    }
  } catch {
    Write-Log "Erro no ciclo de sync: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $PollSeconds
}
