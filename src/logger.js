// 统一的输出格式。错误前缀让用户一眼分清「工具说错了什么」。

export const log = {
  success(message) { console.log("✓ " + message); },
  error(message) { console.error("✗ " + message); },
  info(message) { console.log("· " + message); },
};
