function readArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key || !key.startsWith("--")) throw new Error(`参数格式无效: ${key || "<empty>"}`);
    values[key.slice(2)] = argv[index + 1] || "";
  }
  return values;
}

function requireArg(values, key) {
  const value = String(values[key] || "").trim();
  if (!value) throw new Error(`缺少参数: --${key}`);
  return value;
}

module.exports = { readArgs, requireArg };

