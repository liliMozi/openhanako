import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function shouldBuildComputerUseHelper({ platform = process.platform } = {}) {
  return platform === "darwin";
}

export function swiftArchForNodeArch(arch = process.arch) {
  if (arch === "x64") return "x86_64";
  return arch;
}

export function computerUseHelperOutputDir({
  rootDir = path.resolve(__dirname, ".."),
  osName = "mac",
  arch = process.arch,
} = {}) {
  return path.join(rootDir, "dist-computer-use", `${osName}-${arch}`);
}

export function swiftBuildScratchPath({
  rootDir = path.resolve(__dirname, ".."),
  arch = process.arch,
} = {}) {
  return path.join(rootDir, ".cache", "computer-use-helper", "swift-build", `mac-${arch}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function read(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

export function buildComputerUseHelper({
  rootDir = path.resolve(__dirname, ".."),
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  if (!shouldBuildComputerUseHelper({ platform })) {
    console.log(`[computer-use-helper] skipped on ${platform}`);
    return { skipped: true };
  }

  const packageDir = path.join(rootDir, "desktop", "native", "HanaComputerUseHelper");
  const swiftArch = swiftArchForNodeArch(env.HANA_COMPUTER_USE_HELPER_ARCH || arch);
  const scratchPath = swiftBuildScratchPath({ rootDir, arch });
  const baseArgs = [
    "--package-path",
    packageDir,
    "--scratch-path",
    scratchPath,
    "-c",
    "release",
    "--arch",
    swiftArch,
    "--product",
    "hana-computer-use-helper",
  ];

  console.log(`[computer-use-helper] building for ${swiftArch}`);
  run("swift", ["build", ...baseArgs], { cwd: rootDir, env });

  const binPath = read("swift", ["build", "--show-bin-path", ...baseArgs], { cwd: rootDir, env });
  const source = path.join(binPath, "hana-computer-use-helper");
  if (!fs.existsSync(source)) {
    throw new Error(`[computer-use-helper] build did not produce ${source}`);
  }

  const outDir = computerUseHelperOutputDir({ rootDir, osName: "mac", arch });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, "hana-computer-use-helper");
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  console.log(`[computer-use-helper] copied ${target}`);
  return { skipped: false, target };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    buildComputerUseHelper();
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  }
}
