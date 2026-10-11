/*
 * fox青丘掌事 · 预约送走 流程
 * 依据 dz114879/fox-dayi-bot 的 cogs/quick_punish/commands.py：
 *   - 消息右键命令名「预约送走」，送走对象 = 被右键消息的作者
 *   - 弹窗字段：处罚原因(文本，可空，≤100) / 私信模板(下拉) / 延迟时间(文本，1m-120m 或 1h-2h)
 *   - 成功：公开 embed，标题「预约成功」，描述里 @ 了目标
 *   - 失败：内容以 ❌ 开头的消息
 */

import { Preset, validateDelay } from "./presets";
import { rememberTemplates } from "./settings";
import {
    closeBotModal, Ctx, describeError, findField, findMessageCommand, invalidateCommand, logger, ModalInfo, newNonce,
    parseModal, runMessageCommand, submitModal, waitForDispatch
} from "./interactions";

const COMMAND_NAME = "预约送走";

const isFoxMsg = (e: any, foxId: string, ctx: Ctx) =>
    e.message?.author?.id === foxId && e.message?.channel_id === ctx.channelId;

/** 返回 fox 的成功说明文字（如「将在 xxx 执行」） */
export async function runFox(ctx: Ctx, foxAppId: string, target: any, preset: Preset): Promise<string> {
    validateDelay(preset.delay);
    if ((preset.reason ?? "").length > 100) throw new Error("处罚原因超过 100 字");

    logger.info("[步骤1] 查找 fox 命令", ctx);
    let cmd = await findMessageCommand(ctx.guildId, foxAppId, COMMAND_NAME);
    logger.info("[步骤1] 找到命令", cmd);

    // 1. 触发命令：可能收到弹窗，也可能直接收到 ❌（没权限 / 已有预约）
    const nonce = newNonce();
    const first = waitForDispatch<{ modal?: ModalInfo; error?: string; }>(
        ["INTERACTION_MODAL_CREATE", "MESSAGE_CREATE"],
        (type, e) => {
            if (type === "INTERACTION_MODAL_CREATE" && e.nonce === nonce) return { modal: parseModal(e) };
            if (type === "MESSAGE_CREATE" && isFoxMsg(e, foxAppId, ctx) && e.message.content?.startsWith("❌"))
                return { error: e.message.content };
        },
        10_000,
        "fox 弹窗"
    );
    logger.info("[步骤2] 发送命令交互", nonce);
    try {
        await runMessageCommand(ctx, cmd, target.id, nonce);
    } catch (e: any) {
        // 缓存的命令可能已过期（bot 重新同步过命令），清掉重查一次
        if (e?.status !== 400) throw e;
        logger.warn("命令可能已过期，重新获取", describeError(e));
        await invalidateCommand(ctx.guildId, foxAppId, COMMAND_NAME, 3);
        cmd = await findMessageCommand(ctx.guildId, foxAppId, COMMAND_NAME);
        await runMessageCommand(ctx, cmd, target.id, nonce);
    }
    logger.info("[步骤2] 已发送，等待弹窗");
    const res = await first;
    if (res.error) throw new Error(res.error);
    const modal = res.modal!;
    logger.debug("fox 弹窗", modal);

    // 2. 按标题找字段（custom_id 每次随机，不能写死）
    const reason = findField(modal, "处罚原因");
    const template = findField(modal, "私信模板");
    const delay = findField(modal, "延迟时间");

    rememberTemplates(template.options);

    const tplValue = preset.template || "__none__";
    if (!template.options.some(o => o.value === tplValue)) {
        const list = template.options.map(o => o.value).join("、");
        throw new Error(`fox 没有模板「${tplValue}」，可选：${list}`);
    }

    // 3. 提交并等结果（留存要发到别的频道，给宽一点的时间）
    const result = waitForDispatch<{ ok: boolean; text: string; }>(
        ["MESSAGE_CREATE", "MESSAGE_UPDATE"],
        (_type, e) => {
            if (!isFoxMsg(e, foxAppId, ctx)) return;
            const msg = e.message;
            const embed = msg.embeds?.[0];
            // 回执带 interaction_metadata.triggering_interaction_metadata.target_message_id，可精确对应本次目标
            const targetMsgId = msg.interaction_metadata?.triggering_interaction_metadata?.target_message_id;
            if (targetMsgId && targetMsgId !== target.id) return;
            if (embed?.title === "预约成功" && embed.description?.includes(target.author.id))
                return { ok: true, text: embed.description };
            if (msg.content?.startsWith("❌")) return { ok: false, text: msg.content };
        },
        30_000,
        "fox 回执"
    );

    logger.info("[步骤3] 提交弹窗");
    await submitModal(ctx, modal, {
        [reason.customId]: preset.reason ?? "",
        [template.customId]: [tplValue],
        [delay.customId]: preset.delay
    });
    // TODO: 改成用 patch 阻止弹窗渲染；目前是提交后直接关掉，可能会闪一下
    closeBotModal();

    const r = await result;
    if (!r.ok) throw new Error(r.text);
    return r.text;
}
