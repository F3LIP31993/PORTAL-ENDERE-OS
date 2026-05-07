# Script: auto-git-watcher.ps1
# Monitora alterações na pasta e faz commit/push automático para o Git
# Requer: Git instalado e configurado, permissões de push

$Path = "$PSScriptRoot"  # Pasta atual do script
$Filter = '*.*'           # Monitora todos os arquivos
$GitBranch = 'main'       # Altere se seu branch for diferente

# Função para executar commit e push
function Sync-Git {
    git add .
    $status = git status --porcelain
    if ($status) {
        $msg = "Atualização automática $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        git commit -m "$msg"
        git push origin $GitBranch
        Write-Host "[OK] Alterações enviadas para o Git e Render!" -ForegroundColor Green
    } else {
        Write-Host "Nenhuma alteração detectada para commit."
    }
}

# Cria o watcher
$fsw = New-Object IO.FileSystemWatcher $Path, $Filter -Property @{ 
    IncludeSubdirectories = $true
    EnableRaisingEvents = $true
}

# Evento: ao salvar/modificar/criar/excluir
$onChange = Register-ObjectEvent $fsw Changed -Action { Sync-Git }
$onCreate = Register-ObjectEvent $fsw Created -Action { Sync-Git }
$onDelete = Register-ObjectEvent $fsw Deleted -Action { Sync-Git }
$onRename = Register-ObjectEvent $fsw Renamed -Action { Sync-Git }

Write-Host "Monitorando alterações em: $Path" -ForegroundColor Cyan
Write-Host "Pressione Ctrl+C para sair."

# Mantém o script rodando
while ($true) { Start-Sleep -Seconds 2 }
