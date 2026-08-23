# FX 편집기를 PC 로그인할 때 같이 켜지게 하거나, 그만두게 한다.
#
# 웹 페이지는 PC 프로그램을 켤 수 없다. 그래서 SkoolClass 설정의 「FX 편집기」
# 단추가 항상 통하려면 편집기가 이미 켜져 있어야 한다. 켤 때마다 배치 파일을
# 찾아 더블클릭하는 대신, 로그인할 때 한 번 알아서 켜지게 하는 쪽이 편하다.
#
# 창은 숨기지 않고 작게(최소화) 띄운다. 숨기면 끄고 싶을 때 작업 관리자를
# 열어야 한다.
#
# 주의: 바로가기에는 **지금 드라이브 문자**가 박힌다. 이 폴더가 다른 드라이브로
# 옮겨지면 자동 실행이 조용히 실패하므로 그때는 「켜기」를 다시 눌러야 한다.

param([Parameter(Mandatory = $true)][ValidateSet('on', 'off')][string]$Action)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'FX 편집기.lnk'

if ($Action -eq 'off') {
    if (Test-Path $link) {
        Remove-Item $link -Force
        Write-Host ''
        Write-Host '  껐습니다. 이제 PC 를 켜도 FX 편집기는 안 뜹니다.'
        Write-Host '  쓰고 싶을 때는 FX-Studio.bat 을 더블클릭하세요.'
    } else {
        Write-Host ''
        Write-Host '  원래 꺼져 있었습니다. 바꾼 것 없습니다.'
    }
    Write-Host ''
    return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Host ''
    Write-Host '  node.exe 를 못 찾았습니다. Node.js 가 깔린 상태에서 다시 실행해 주세요.'
    Write-Host ''
    exit 1
}

$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($link)
$s.TargetPath = $node
$s.Arguments = '"' + (Join-Path $root 'scripts\fx-studio.mjs') + '"'
$s.WorkingDirectory = $root
$s.WindowStyle = 7          # 최소화 — 있는 건 보이되 앞을 가리지 않게
$s.Description = 'SkoolClass FX 편집기 (localhost:4321)'
$s.Save()

Write-Host ''
Write-Host '  켰습니다. 이제 PC 를 켤 때마다 FX 편집기가 같이 켜집니다.'
Write-Host ('  창은 작업표시줄에 작게 뜹니다 — 주소는 http://localhost:4321')
Write-Host ''
Write-Host ('  바로가기: ' + $link)
Write-Host ('  가리키는 곳: ' + $root)
Write-Host ''
Write-Host '  지금 바로 한 번 켜려면 FX-Studio.bat 을 더블클릭하세요.'
Write-Host ''
