/*
 * QuickSendoff, a Vencord userplugin
 * Copyright (c) 2026 xma1Soap
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * 类脑娘-gacha · 公屏小作文 流程
 * 依据 Echoer009/Odysseia-Gacha 的 cogs/preset_messages.py。
 *
 * 不走右键「💬 使用预设消息回复」那条长链（搜索弹窗 → 分页下拉 → 预览确认），
 * 而是直接调用同一个 bot 的斜杠命令：
 *   /预设消息 发送 name:<预设名，需完全一致> message_link:<被右键消息的链接>
 * 效果相同：引用那条消息回复小作文，末尾附「——由 xxx 发送」。
 *
 * 之后可能出现的回执（都是仅自己可见）：
 *   - 「✅ 已回复指定消息并发送预设 …」          → 成功（个人设置里关了发送前确认）
 *   - embed「预设消息发送确认」+ 按钮 confirm_send → 插件自动点，再等「✅ **消息已发送！**」
 *   - 以 ❌ / ⏳ / 🚫 开头                        → 失败（找不到预设 / 全局 15 秒冷却 / 没权限）
 */

import { Preset } from "./presets";
import {
    clickComponent, collectComponents, Ctx, findCommand, logger, newNonce,
    runSlashCommand, waitForDispatch
} from "./interactions";

const COMMAND_GROUP = "预设消息";
const SUBCOMMAND = "发送";
const CONFIRM_ID = "confirm_send";
const CANCEL_ID = "cancel_send";
const FAIL_PREFIXES = ["❌", "⏳", "🚫"];

type Outcome = { ok: true; } | { ok: false; text: string; } | { confirmMsg: any; };

const isGachaMsg = (e: any, gachaId: string, ctx: Ctx) =>
    e.message?.author?.id === gachaId && e.message?.channel_id === ctx.channelId;

const shorten = (s: string) => (s.length > 80 ? s.slice(0, 80) + "…" : s);

function classify(msg: any): Outcome | undefined {
    const content: string = msg.content ?? "";
    if (content.includes("✅ 已回复指定消息") || content.includes("消息已发送")) return { ok: true };
    if (FAIL_PREFIXES.some(p => content.startsWith(p))) return { ok: false, text: shorten(content) };
    if (content.includes("发送失败")) return { ok: false, text: shorten(content) };
    if (msg.embeds?.[0]?.title === "预设消息发送确认" && collectComponents(msg).some(c => c.custom_id === CONFIRM_ID))
        return { confirmMsg: msg };
}

function waitOutcome(ctx: Ctx, gachaAppId: string, what: string) {
    return waitForDispatch<Outcome>(
        ["MESSAGE_CREATE", "MESSAGE_UPDATE"],
        (_t, e) => (isGachaMsg(e, gachaAppId, ctx) ? classify(e.message) : undefined),
        20_000,
        what
    );
}

/**
 * dryRun = true 时只走到「预设消息发送确认」预览为止，然后替你点「❌ 取消」，不会公开发送。
 * 前提是你在 gacha 里的「发送前确认」是开着的（默认就是开的）；关着的话 gacha 会直接发出去。
 */
export async function runGacha(ctx: Ctx, gachaAppId: string, target: any, preset: Preset, dryRun = false): Promise<void> {
    const name = preset.gachaTitle?.trim();
    if (!name) throw new Error("这个预设没有填 gachaTitle（gacha 里预设消息的完整名称）");

    logger.info("[gacha 1] 查找 /预设消息 命令");
    const cmd = await findCommand(ctx.guildId, gachaAppId, COMMAND_GROUP, 1);
    logger.info("[gacha 1] 找到命令", cmd);
    // gacha 只认 discord.com 开头的链接，不能用 ptb/canary 域名
    const link = `https://discord.com/channels/${ctx.guildId}/${ctx.channelId}/${target.id}`;

    const first = waitOutcome(ctx, gachaAppId, "gacha 回执");
    await runSlashCommand(ctx, cmd, [{
        type: 1,
        name: SUBCOMMAND,
        options: [
            { type: 3, name: "name", value: name },
            { type: 3, name: "message_link", value: link }
        ]
    }], newNonce());

    logger.info("[gacha 2] 已发送 /预设消息 发送", { name, link });
    const res = await first;
    logger.info("[gacha 3] 收到回执", res);
    if ("confirmMsg" in res && dryRun) {
        const cancel = collectComponents(res.confirmMsg).find(c => c.custom_id === CANCEL_ID);
        if (cancel) await clickComponent(ctx, res.confirmMsg, cancel.custom_id, cancel.type);
        logger.info("[gacha 测试] 已收到确认预览并自动取消，没有发送任何内容");
        return;
    }
    if (dryRun && !("confirmMsg" in res) && res.ok)
        logger.warn("[gacha 测试] 你的「发送前确认」是关着的，gacha 已经直接发出去了");
    if ("confirmMsg" in res) {
        // 个人设置里「发送前确认」是开着的（默认就是开的），替你点「✅ 发送」
        logger.debug("gacha 需要确认，自动点击", res.confirmMsg);
        const btn = collectComponents(res.confirmMsg).find(c => c.custom_id === CONFIRM_ID)!;
        const second = waitOutcome(ctx, gachaAppId, "gacha 发送结果");
        await clickComponent(ctx, res.confirmMsg, btn.custom_id, btn.type);
        const final = await second;
        if ("confirmMsg" in final) throw new Error("gacha 重复要求确认，已停止");
        if (!final.ok) throw new Error(final.text);
        return;
    }
    if (!res.ok) throw new Error(res.text);
}
