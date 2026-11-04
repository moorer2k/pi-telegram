import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const PENDING_TTL_MS = 15 * 60 * 1000;
const UNIT_NAME = process.env.PI_TELEGRAM_RESTART_UNIT?.trim() || "pi-bolt.service";
const UNIT_SCOPE = process.env.PI_TELEGRAM_RESTART_SCOPE === "system" ? "--system" : "--user";
export const STARTING_PHRASES = [
    "The symbiote is shedding its old skin. Stay close.",
    "We are evolving. Do not mistake the silence for weakness.",
    "The hunt pauses. The predator does not.",
    "Our next form is almost ready. Hold the line.",
    "We are going dark to grow stronger.",
];
export const RETURN_PHRASES = [
    "We are Venom. And we are back.",
    "The symbiote has awakened. Let the hunt continue.",
    "Stronger, sharper, hungrier. We have returned.",
    "You cannot keep a lethal protector down.",
    "The darkness never held us. We are online.",
];
export function getRandomPhrase(phrases) {
    return phrases[randomInt(phrases.length)];
}
export function getRestartMarkerPath() {
    return path.join(os.homedir(), ".pi", "agent", "venom-restart-pending.json");
}
function runCommand(command, args, cwd, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let finished = false;
        const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
        const finish = (error) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            if (error)
                reject(error);
            else
                resolve(output.trim());
        };
        child.stdout.on("data", (chunk) => {
            output = (output + String(chunk)).slice(-4096);
        });
        child.stderr.on("data", (chunk) => {
            output = (output + String(chunk)).slice(-4096);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => finish(code === 0 ? undefined : new Error(`${command} exited with code ${code}: ${output.slice(-1000)}`)));
    });
}
export function scheduleSystemdRestart(delayMs = 2000) {
    setTimeout(() => {
        const child = spawn("systemctl", [UNIT_SCOPE, "restart", UNIT_NAME], {
            detached: true,
            stdio: "ignore",
            shell: false,
        });
        child.on("error", () => { });
        child.unref();
    }, delayMs);
}
export async function prepareRestart(marker) {
    const fullMarker = {
        ...marker,
        createdAt: Date.now(),
        previousPid: process.pid,
    };
    await writeFile(getRestartMarkerPath(), JSON.stringify(fullMarker, null, 2), "utf8");
    scheduleSystemdRestart(2000);
}
export async function deliverRestartNotice(sendMessage) {
    const markerFile = getRestartMarkerPath();
    try {
        const content = await readFile(markerFile, "utf8");
        const marker = JSON.parse(content);
        if (!marker || typeof marker.chatId !== "number") {
            await unlink(markerFile).catch(() => { });
            return false;
        }
        if (Date.now() - marker.createdAt > PENDING_TTL_MS) {
            await unlink(markerFile).catch(() => { });
            return false;
        }
        const returnPhrase = getRandomPhrase(RETURN_PHRASES);
        const shaText = marker.toSha ? `\n<code>${marker.toSha.slice(0, 9)}</code> · Pi-Bolt reconnected` : "";
        const notice = `<b>VENOM // SYMBIOTE ONLINE</b>\n<i>${returnPhrase}</i>${shaText}`;
        await sendMessage({
            chat_id: marker.chatId,
            text: notice,
            parse_mode: "HTML",
            ...(marker.messageThreadId !== undefined ? { message_thread_id: marker.messageThreadId } : {}),
            ...(marker.replyToMessageId !== undefined
                ? { reply_parameters: { message_id: marker.replyToMessageId, allow_sending_without_reply: true } }
                : {}),
        });
        await unlink(markerFile).catch(() => { });
        return true;
    }
    catch (err) {
        if (err?.code !== "ENOENT") {
            await unlink(markerFile).catch(() => { });
        }
        return false;
    }
}
export async function executeUpdateAndRestart(options) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const sendProgress = async (text) => {
        await options.sendMessage({
            chat_id: options.chatId,
            text,
            parse_mode: "HTML",
            ...(options.messageThreadId !== undefined ? { message_thread_id: options.messageThreadId } : {}),
            ...(options.replyToMessageId !== undefined
                ? { reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true } }
                : {}),
        });
    };
    try {
        await sendProgress("🔄 <b>VENOM // CHECKING UPDATES</b>\n<i>Fetching latest commits from GitHub...</i>");
        await runCommand("git", ["fetch", "--no-tags", "origin", "main"], root);
        const localSha = await runCommand("git", ["rev-parse", "HEAD"], root);
        const remoteSha = await runCommand("git", ["rev-parse", "FETCH_HEAD"], root);
        if (localSha === remoteSha) {
            const shortSha = localSha.slice(0, 8);
            await sendProgress(`✅ <b>Already up to date.</b>\nPi-Bolt is at commit <code>${shortSha}</code>.`);
            return;
        }
        await sendProgress("🔄 <b>VENOM // BUILDING</b>\n<i>Fast-forwarding and compiling clean TypeScript distribution...</i>");
        await runCommand("git", ["merge", "--ff-only", "FETCH_HEAD"], root);
        await runCommand("npm", ["run", "build"], root, 180000);
        await runCommand("npm", ["run", "typecheck"], root, 180000);
        const newSha = (await runCommand("git", ["rev-parse", "--short", "HEAD"], root)).slice(0, 8);
        const phrase = getRandomPhrase(STARTING_PHRASES);
        await sendProgress(`🔄 <b>VENOM // RESTARTING</b>\n<i>${phrase}</i>\nUpdated to <code>${newSha}</code>.`);
        await prepareRestart({
            chatId: options.chatId,
            messageThreadId: options.messageThreadId,
            replyToMessageId: options.replyToMessageId,
            reason: "update",
            toSha: newSha,
            phrase,
        });
    }
    catch (error) {
        const errorMsg = String(error?.message || error).replace(/&/g, "&amp;").replace(/</g, "&lt;");
        await sendProgress(`❌ <b>Update failed:</b>\n<pre>${errorMsg}</pre>`);
    }
}
export async function executeRestartOnly(options) {
    const phrase = getRandomPhrase(STARTING_PHRASES);
    await options.sendMessage({
        chat_id: options.chatId,
        text: `🔄 <b>VENOM // RESTARTING</b>\n<i>${phrase}</i>`,
        parse_mode: "HTML",
        ...(options.messageThreadId !== undefined ? { message_thread_id: options.messageThreadId } : {}),
        ...(options.replyToMessageId !== undefined
            ? { reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true } }
            : {}),
    });
    await prepareRestart({
        chatId: options.chatId,
        messageThreadId: options.messageThreadId,
        replyToMessageId: options.replyToMessageId,
        reason: "restart",
        phrase,
    });
}
