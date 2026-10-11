/*
 * 从 类脑娘-gacha 拉取全部预设消息名称。
 * 调用的是只读命令 /预设消息 列表（仅自己可见、无冷却、不发任何东西到公屏），
 * 依据 Echoer009/Odysseia-Gacha：
 *   - 列表是 embed，标题「📜 xxx 的预设消息列表」，描述里每行「- `名称`」
 *   - 分页按钮 custom_id 为 prev_page_list / next_page_list，中间按钮文字「第 n/m 页」
 *   - 没有预设时回「ℹ️ 当前服务器还没有任何预设消息。」
 */

import { ChannelStore, SelectedChannelStore } from "@webpack/common";

import {
    clickComponent, collectComponents, Ctx, findCommand, logger, newNonce,
    runSlashCommand, waitForDispatch
} from "./interactions";

const NAME_RE = /^- `(.+)`\s*$/gm;
const PAGE_RE = /第\s*(\d+)\s*\/\s*(\d+)\s*页/;

function parsePage(msg: any) {
    const desc: string = msg.embeds?.[0]?.description ?? "";
    const names = [...desc.matchAll(NAME_RE)].map(m => m[1]);
    const indicator = collectComponents(msg).map(c => c.label ?? "").find(l => PAGE_RE.test(l));
    const m = indicator ? PAGE_RE.exec(indicator) : null;
    return { names, page: m ? +m[1] : 1, total: m ? +m[2] : 1 };
}

const isListMsg = (msg: any) =>
    msg?.embeds?.[0]?.title?.includes("预设消息列表") || msg?.content?.includes("还没有任何预设消息");

export async function fetchGachaPresets(gachaAppId: string): Promise<string[]> {
    if (!gachaAppId) throw new Error("先在上面填 gacha 的应用 ID");
    const channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());
    if (!channel?.guild_id) throw new Error("请先打开类脑服务器里的任意一个频道，再点获取");
    const ctx: Ctx = { guildId: channel.guild_id, channelId: channel.id };

    const cmd = await findCommand(ctx.guildId, gachaAppId, "预设消息", 1);
    const fromGacha = (e: any) => e.message?.author?.id === gachaAppId && e.message?.channel_id === ctx.channelId;

    const firstP = waitForDispatch(
        ["MESSAGE_CREATE", "MESSAGE_UPDATE"],
        (_t, e) => (fromGacha(e) && isListMsg(e.message) ? e.message : undefined),
        15_000,
        "gacha 预设列表"
    );
    await runSlashCommand(ctx, cmd, [{ type: 1, name: "列表" }], newNonce());
    let msg = await firstP;
    if (!msg.embeds?.length) return [];

    const names = new Set<string>();
    let { names: pageNames, page, total } = parsePage(msg);
    pageNames.forEach(n => names.add(n));
    logger.info(`[gacha 列表] 第 ${page}/${total} 页，${pageNames.length} 条`);

    for (let guard = 0; page < total && guard < 100; guard++) {
        const next = collectComponents(msg).find(c => c.custom_id === "next_page_list");
        if (!next || next.disabled) break;
        const expected = page + 1;
        const nextP = waitForDispatch(
            ["MESSAGE_UPDATE"],
            (_t, e) => (e.message?.id === msg.id && parsePage(e.message).page === expected ? e.message : undefined),
            10_000,
            `gacha 列表第 ${expected} 页`
        );
        await clickComponent(ctx, msg, next.custom_id, next.type);
        msg = await nextP;
        ({ names: pageNames, page, total } = parsePage(msg));
        pageNames.forEach(n => names.add(n));
        logger.info(`[gacha 列表] 第 ${page}/${total} 页，${pageNames.length} 条`);
    }

    return [...names];
}
