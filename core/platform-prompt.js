export function getPlatformPromptNote({ platform = process.platform, isZh }) {
  if (platform !== "win32") return "";

  return isZh
    ? [
        "你当前运行在 Windows 上。",
        "当用户明确要求使用 cmd 或 PowerShell 时，必须尊重，不要擅自更换 shell。",
        "像 ipconfig、dir、netsh、reg、sc 这类 Windows 原生命令，应按 Windows 语义理解。",
        "对于 /all、/renew6 这类 /参数，先依据真实执行结果判断，不要臆断参数不存在。",
      ].join("\n")
    : [
        "You are currently running on Windows.",
        "If the user explicitly asks for cmd or PowerShell, respect that shell choice.",
        "Treat commands like ipconfig, dir, netsh, reg, and sc as native Windows commands.",
        "Do not assume switches like /all or /renew6 are invalid without checking the real execution result.",
      ].join("\n");
}
