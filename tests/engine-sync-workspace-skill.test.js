import { describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../core/engine.js";

/**
 * 针对 HanaEngine.syncWorkspaceSkillPaths 的最小单测。
 *
 * syncWorkspaceSkillPaths 在"externalPaths 列表没变"时默认短路 return false，不 reload
 * 也不 emit。上传/删除 workspace skill 的场景（dirPath 不变，内容变）必须用 force: true
 * 绕过这个短路，否则会和 chokidar watcher 的 dot-ignore bug 叠加成用户看不到变化的 bug。
 */
describe("HanaEngine.syncWorkspaceSkillPaths", () => {
  function makeFakeEngine(initialPaths) {
    const engine = Object.create(HanaEngine.prototype);
    const skills = {
      _externalPaths: initialPaths,
      setExternalPaths: vi.fn((paths) => { skills._externalPaths = paths; }),
    };
    engine._skills = skills;
    engine._getResolvedExternalSkillPaths = vi.fn(() => initialPaths);
    engine.reloadSkills = vi.fn().mockResolvedValue(undefined);
    engine._emitEvent = vi.fn();
    return engine;
  }

  it("externalPaths 没变化时默认短路，不调用 reload / emit", async () => {
    const paths = [{ dirPath: "/x", label: "Agents", scope: "workspace" }];
    const engine = makeFakeEngine(paths);

    const result = await engine.syncWorkspaceSkillPaths("/cwd", {
      reload: true,
      emitEvent: true,
    });

    expect(result).toBe(false);
    expect(engine._skills.setExternalPaths).not.toHaveBeenCalled();
    expect(engine.reloadSkills).not.toHaveBeenCalled();
    expect(engine._emitEvent).not.toHaveBeenCalled();
  });

  it("force: true 会绕过短路强制 reload + emit，用于 workspace skill 文件变化", async () => {
    const paths = [{ dirPath: "/x", label: "Agents", scope: "workspace" }];
    const engine = makeFakeEngine(paths);

    const result = await engine.syncWorkspaceSkillPaths("/cwd", {
      reload: true,
      emitEvent: true,
      force: true,
    });

    expect(result).toBe(true);
    expect(engine._skills.setExternalPaths).toHaveBeenCalledWith(paths);
    expect(engine.reloadSkills).toHaveBeenCalledTimes(1);
    expect(engine._emitEvent).toHaveBeenCalledWith({ type: "skills-changed" }, null);
  });

  it("force: true 但 reload: false 只触发 setExternalPaths，不触发 reload", async () => {
    const paths = [{ dirPath: "/x", label: "Agents", scope: "workspace" }];
    const engine = makeFakeEngine(paths);

    await engine.syncWorkspaceSkillPaths("/cwd", { reload: false, force: true });

    expect(engine._skills.setExternalPaths).toHaveBeenCalled();
    expect(engine.reloadSkills).not.toHaveBeenCalled();
  });
});
