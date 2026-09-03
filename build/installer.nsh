; NSIS 安装器脚本：把 EnvVault 的安装目录写进当前用户的 PATH。
;
; 这是阶段 5a 推迟的那件事 —— `envvault run -- <命令>` 只有进了 PATH 才好用，
; 否则用户得每次敲完整路径，那个 CLI 就没人会用。
;
; 🔴 只改 HKCU（当前用户）的 PATH，不碰 HKLM。
; perMachine 是 false，安装本来就不需要管理员权限；去改系统级 PATH 会要求提权，
; 而一个配置管理工具没有理由要管理员权限。
;
; 🔴 卸载时**只在能安全判断的情况下移除**，判断不了就留着。
;
; 第一版写了一个通用的字符串替换函数去精确删除那一段。想清楚之后否掉了：
; PATH 是用户开发环境的命脉，一个字符串替换写错一次就是把它弄坏，
; 而症状（"我的命令怎么都找不到了"）和这个卸载程序看不出任何关系。
; 留下一条指向已删除目录的 PATH 项是**无害**的 —— Windows 找不到就跳过。
; 两害相权，宁可留垃圾也不冒险动刀。
;
; ⚠️ 未验证：这段脚本能编译通过（打包时 makensis 会编译它），但
; 「装完之后 PATH 里真的有了、卸载之后真的没了」需要实际跑一遍安装器才知道。
; 这台机器上没有跑过，RELEASE.md 里如实标着。

!include "LogicLib.nsh"

!macro customInstall
  ReadRegStr $R0 HKCU "Environment" "PATH"

  ${If} $R0 == ""
    WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR"
    DetailPrint "已把 $INSTDIR 加入 PATH"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${Else}
    ; 包含判断：在 ";<PATH>;" 里找 ";<INSTDIR>;"。
    ; 两头补分号是为了避免 `C:\App` 命中 `C:\AppData` 这种前缀误判。
    StrCpy $R1 ";$R0;"
    StrCpy $R2 ";$INSTDIR;"
    StrLen $R3 $R2
    StrCpy $R4 0
    StrCpy $R5 "no"

    envvault_scan:
      StrCpy $R6 $R1 $R3 $R4
      ${If} $R6 == ""
        Goto envvault_scanned
      ${EndIf}
      ${If} $R6 == $R2
        StrCpy $R5 "yes"
        Goto envvault_scanned
      ${EndIf}
      IntOp $R4 $R4 + 1
      Goto envvault_scan
    envvault_scanned:

    ${If} $R5 == "yes"
      DetailPrint "PATH 里已经有 $INSTDIR，跳过"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "PATH" "$R0;$INSTDIR"
      DetailPrint "已把 $INSTDIR 加入 PATH"
      ; 通知系统环境变量变了，新开的终端才读得到；不发的话要重新登录。
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ReadRegStr $R0 HKCU "Environment" "PATH"

  ; 只处理两种能安全判断的情形：整条就是我们、或者我们在末尾。
  ; 夹在中间时不动 —— 见文件顶部关于"宁可留垃圾"的那段。
  ${If} $R0 == "$INSTDIR"
    WriteRegExpandStr HKCU "Environment" "PATH" ""
    DetailPrint "已从 PATH 移除 $INSTDIR"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${Else}
    StrLen $R1 ";$INSTDIR"
    StrLen $R2 $R0
    IntOp $R3 $R2 - $R1
    ${If} $R3 >= 0
      StrCpy $R4 $R0 $R1 $R3
      ${If} $R4 == ";$INSTDIR"
        StrCpy $R5 $R0 $R3
        WriteRegExpandStr HKCU "Environment" "PATH" "$R5"
        DetailPrint "已从 PATH 移除 $INSTDIR"
        SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
      ${Else}
        DetailPrint "$INSTDIR 不在 PATH 末尾，保持不动（留一条失效项无害，改坏 PATH 有害）"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
