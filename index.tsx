/*
 * QuickSendoff · 一键送走
 * 给类脑答疑组用：右键违规消息 → 一键送走 → 选预设
 *   1) 调 fox青丘掌事 的「预约送走」，自动填原因/私信模板/延迟并提交
 *   2) fox 回执成功后，可选地调 类脑娘-gacha 的 /预设消息 发送，在公屏引用该消息发小作文
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
// 不同版本 Vencord 的类型包路径不一样，这里直接放宽
type Message = any;
import { Alerts, ChannelStore, Menu, showToast } from "@webpack/common";

import { runFox } from "./foxFlow";
import { runGacha } from "./gachaFlow";
import { Ctx, describeError, logger } from "./interactions";
import { parsePresets, Preset } from "./presets";
import { settings } from "./settings";


let running = false;

async function execute(message: Message, ctx: Ctx, preset: Preset) {
    const { foxAppId, gachaAppId, enableGacha } = settings.store;
    running = true;
    let foxDone = false;
    try {
        showToast(`正在预约送走 ${message.author.username}…`);
        const notice = await runFox(ctx, foxAppId, message, preset);
        foxDone = true;
        logger.info("fox 成功", notice);

        if (enableGacha && gachaAppId && preset.gachaTitle) {
            await runGacha(ctx, gachaAppId, message, preset);
            showToast("已预约送走并公示小作文", "success");
        } else {
            showToast("预约送走成功", "success");
        }
    } catch (e: any) {
        logger.error("一键送走失败", e);
        const msg = describeError(e);
        showToast(foxDone ? `已预约送走，但公示失败：${msg}，请手动补发` : `送走失败：${msg}`, "failure");
    } finally {
        running = false;
    }
}

/** 抓包模式下的安全测试：只走到 gacha 的确认预览，然后自动取消 */
async function testGacha(message: Message, preset: Preset) {
    if (running) return showToast("上一个操作还在进行中", "failure");
    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel?.guild_id) return showToast("只能在服务器里使用", "failure");
    running = true;
    try {
        await runGacha({ guildId: channel.guild_id, channelId: channel.id }, settings.store.gachaAppId, message, preset, true);
        showToast("gacha 测试通过（已自动取消，未发送）", "success");
    } catch (e: any) {
        logger.error("gacha 测试失败", e);
        showToast(`gacha 测试失败：${describeError(e)}`, "failure");
    } finally {
        running = false;
    }
}

function start(message: Message, preset: Preset) {
    if (running) return showToast("上一个送走还在进行中", "failure");
    if (message.author.bot) return showToast("不能对 Bot 使用", "failure");
    if (!settings.store.foxAppId) return showToast("先在插件设置里填 fox 的应用 ID", "failure");

    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel?.guild_id) return showToast("只能在服务器里使用", "failure");
    const ctx: Ctx = { guildId: channel.guild_id, channelId: channel.id };

    if (!settings.store.confirmBeforeRun) return void execute(message, ctx, preset);

    const lines = [
        `对象：${message.author.username}（${message.author.id}）`,
        `原因：${preset.reason || "违规第三方"}`,
        `私信模板：${preset.template === "__none__" ? "默认（第三方API）" : preset.template}`,
        `延迟：${preset.delay}`,
        settings.store.enableGacha && preset.gachaTitle ? `公屏小作文：${preset.gachaTitle}` : null
    ].filter(Boolean);

    Alerts.show({
        title: `一键送走 · ${preset.name}`,
        body: <div style={{ whiteSpace: "pre-line" }}>{lines.join("\n")}</div>,
        confirmText: "送走",
        cancelText: "取消",
        onConfirm: () => void execute(message, ctx, preset)
    });
}

const messageMenuPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!message || message.author?.bot) return;
    const presets = parsePresets(settings.store.presets).filter(p => p.name.trim());

    children.push(
        <Menu.MenuItem id="vc-quick-sendoff" label="一键送走">
            {presets.map((p, i) => (
                <Menu.MenuItem
                    key={i}
                    id={`vc-quick-sendoff-${i}`}
                    label={p.name}
                    action={() => start(message, p)}
                />
            ))}
            {settings.store.debug && settings.store.gachaAppId && presets.some(p => p.gachaTitle) && (
                <Menu.MenuItem id="vc-quick-sendoff-gacha-test" label="🧪 仅测试 gacha（不发送）">
                    {presets.filter(p => p.gachaTitle).map((p, i) => (
                        <Menu.MenuItem
                            key={i}
                            id={`vc-quick-sendoff-gacha-test-${i}`}
                            label={p.gachaTitle!}
                            action={() => testGacha(message, p)}
                        />
                    ))}
                </Menu.MenuItem>
            )}
        </Menu.MenuItem>
    );
};

const isWatchedBot = (id?: string) =>
    !!id && (id === settings.store.foxAppId || id === settings.store.gachaAppId);

export default definePlugin({
    name: "QuickSendoff",
    description: "答疑组一键预约送走：自动填写 fox青丘掌事 的预约送走弹窗，并可串联 类脑娘-gacha 公示小作文",
    authors: [{ name: "xma1Soap", id: 0n }],
    settings,

    contextMenus: {
        "message": messageMenuPatch
    },

    // 抓包模式：把需要核对的原始数据打到控制台（Ctrl+Shift+I 查看）
    flux: {
        INTERACTION_MODAL_CREATE(e: any) {
            if (settings.store.debug) logger.info("[抓包] 弹窗", e);
        },
        MESSAGE_CREATE(e: any) {
            if (settings.store.debug && isWatchedBot(e.message?.author?.id)) logger.info("[抓包] 新消息", e.message);
        },
        MESSAGE_UPDATE(e: any) {
            if (settings.store.debug && isWatchedBot(e.message?.author?.id)) logger.info("[抓包] 消息更新", e.message);
        }
    },
});
