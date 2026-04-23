import { emitSessionShutdown } from "../lib/pi-sdk/index.js";

/**
 * 统一释放 session 相关资源。
 *
 * 顺序契约：
 *   1. emit session_shutdown
 *   2. 调用 Hanako 层 unsub
 *   3. 调用 session.dispose()
 *
 * 任一步失败都只 warn，不阻断后续清理。
 *
 * @param {object} args
 * @param {object|null} args.session
 * @param {(() => void)|null} [args.unsub]
 * @param {string} args.label
 * @param {(msg: string) => void} [args.warn]
 */
export async function teardownSessionResources({ session, unsub, label, warn }) {
  try {
    if (session) {
      await emitSessionShutdown(session);
    }
  } catch (err) {
    warn?.(`${label}: emitSessionShutdown failed: ${err.message}`);
  }

  try {
    unsub?.();
  } catch (err) {
    warn?.(`${label}: unsub failed: ${err.message}`);
  }

  try {
    session?.dispose?.();
  } catch (err) {
    warn?.(`${label}: session.dispose failed: ${err.message}`);
  }
}
