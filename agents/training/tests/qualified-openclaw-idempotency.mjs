import fs from "node:fs";
import path from "node:path";

const distRoot = path.resolve(process.argv[2] ?? "");
if (!distRoot || !fs.statSync(distRoot, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error("OpenClaw dist root is required");
}

function files(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

let source = "";
let sourceFile = "";
for (const file of files(distRoot)) {
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("telegram.message-dispatch-dedupe") && text.includes("buildTelegramMessageDispatchStoredReplayKey")) {
    source = text;
    sourceFile = file;
    break;
  }
}
if (!source) throw new Error("Qualified OpenClaw Telegram message-dispatch dedupe implementation not found");

const required = [
  [/TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS\s*=\s*6048e5/, "7-day Telegram message-dispatch dedupe TTL"],
  [/"account"\s*,\s*params\.accountId/, "account identity in replay key"],
  [/"bot"\s*,\s*String\(params\.botUserId\)/, "bot identity in replay key"],
  [/"message"\s*,\s*String\(chatId\)\s*,\s*messageId/, "chat/message identity in replay key"],
  [/claim\.kind\s*===\s*"duplicate"/, "duplicate message rejection"],
  [/commitTelegramMessageDispatchReplay/, "persistent replay commit path"],
];
for (const [pattern, label] of required) {
  if (!pattern.test(source)) throw new Error(`Qualified OpenClaw is missing ${label}`);
}

console.log(`TRAINING_QUALIFIED_TELEGRAM_DEDUPE_PASS source=${path.relative(distRoot, sourceFile)}`);
