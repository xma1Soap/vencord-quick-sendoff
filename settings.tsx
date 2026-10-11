/*
 * QuickSendoff, a Vencord userplugin
 * Copyright (c) 2026 xma1Soap
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { PresetEditor } from "./presetEditor";
import { DEFAULT_PRESETS } from "./presets";

/** 类脑服务器里两个 bot 的应用 ID（= bot 用户 ID），抓包确认 */
export const FOX_APP_ID = "1409882731634098328";
export const GACHA_APP_ID = "1397863328520601772";

/** fox 私信模板的已知选项。每次真正打开 fox 弹窗时会用实际下拉选项自动刷新。 */
export const DEFAULT_TEMPLATES = [
    { label: "默认（第三方API）", value: "__none__" },
    { label: "tavo等付费平台.txt", value: "tavo等付费平台.txt" },
    { label: "买的云酒馆.txt", value: "买的云酒馆.txt" },
    { label: "劝冲水.txt", value: "劝冲水.txt" },
    { label: "贩子API.txt", value: "贩子API.txt" }
];

export const settings = definePluginSettings({
    foxAppId: {
        type: OptionType.STRING,
        description: "fox青丘掌事 的应用 ID（已内置类脑的 fox，一般不用改）",
        default: FOX_APP_ID
    },
    gachaAppId: {
        type: OptionType.STRING,
        description: "类脑娘-gacha 的应用 ID（已内置类脑的 gacha，一般不用改）",
        default: GACHA_APP_ID
    },
    enableGacha: {
        type: OptionType.BOOLEAN,
        description: "送走成功后，接着让 gacha 在公屏引用那条消息发小作文",
        default: false
    },
    confirmBeforeRun: {
        type: OptionType.BOOLEAN,
        description: "执行前弹一次确认框",
        default: true
    },
    presetEditor: {
        type: OptionType.COMPONENT,
        description: "送走预设",
        component: () => <PresetEditor />
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "抓包模式：在控制台打印 fox/gacha 的弹窗和消息原始数据，并在右键菜单里显示「🧪 仅测试 gacha」",
        default: false
    },
    // 下面两项由可视化编辑器 / 插件自己维护，不直接显示
    presets: {
        type: OptionType.STRING,
        description: "预设原始数据（JSON），请用上面的可视化编辑器修改",
        multiline: true,
        default: JSON.stringify(DEFAULT_PRESETS, null, 2),
        hidden: true
    },
    knownGachaPresets: {
        type: OptionType.STRING,
        description: "gacha 预设名缓存（点编辑器里的「从 gacha 获取」时刷新）",
        default: "[]",
        hidden: true
    },
    knownTemplates: {
        type: OptionType.STRING,
        description: "fox 私信模板缓存（自动维护）",
        default: JSON.stringify(DEFAULT_TEMPLATES),
        hidden: true
    }
});

export function getKnownTemplates(): { label: string; value: string; }[] {
    try {
        const list = JSON.parse(settings.store.knownTemplates);
        if (Array.isArray(list) && list.length) return list;
    } catch { }
    return DEFAULT_TEMPLATES;
}

/** fox 弹窗里看到实际模板列表时调用，保持下拉选项和 fox 同步 */
export function rememberTemplates(options: { label: string; value: string; }[]) {
    if (!options.length) return;
    const next = JSON.stringify(options.map(o => ({ label: o.label, value: o.value })));
    if (next !== settings.store.knownTemplates) settings.store.knownTemplates = next;
}

export function getKnownGachaPresets(): string[] {
    try {
        const list = JSON.parse(settings.store.knownGachaPresets);
        if (Array.isArray(list)) return list.filter(x => typeof x === "string");
    } catch { }
    return [];
}

export function rememberGachaPresets(names: string[]) {
    settings.store.knownGachaPresets = JSON.stringify(names);
}
