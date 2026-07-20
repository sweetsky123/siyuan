import {App} from "../index";
import {Menu} from "./Menu";
import {setStorageVal} from "../protyle/util/compatibility";
/// #if !MOBILE
import {openSetting} from "../config";
import {setTabPosition} from "../layout/tabUtil";
/// #endif
/// #if MOBILE && MOBILE_MARKET
import {openModel} from "../mobile/menu/model";
import {bindSettingSaveDelegation} from "../config/setting/save";
import {mountBazaarTab} from "../config/bazaar";
/// #endif
import {Constants} from "../constants";

export const openTopBarMenu = (app: App, target?: Element) => {
    const menu = new Menu(Constants.MENU_BAR_PLUGIN);
    /// #if !MOBILE || MOBILE_MARKET
    menu.addItem({
        id: "manage",
        icon: "iconSettings",
        label: window.siyuan.languages.manage,
        ignore: window.siyuan.config.readonly,
        click() {
            /// #if MOBILE
            openModel({
                title: window.siyuan.languages.bazaar,
                icon: "iconBazaar",
                html: `<div class="config config--mobile" style="height:100%;min-height:0"></div>`,
                bindEvent(modelMainElement: HTMLElement) {
                    const root = modelMainElement.firstElementChild as HTMLElement;
                    bindSettingSaveDelegation(root);
                    mountBazaarTab(root, undefined, app);
                }
            });
            /// #else
            openSetting(app, "bazaar");
            /// #endif
        }
    });
    menu.addSeparator({id: "separator_1", ignore: window.siyuan.config.readonly});
    /// #endif
    let hasPlugin = false;
    app.plugins.forEach((plugin) => {
        // @ts-ignore
        const hasSetting = plugin.setting || plugin.__proto__.hasOwnProperty("openSetting");
        let hasTopBar = false;
        for (let i = 0; i < plugin.topBarIcons.length; i++) {
            const item = plugin.topBarIcons[i];
            if (!document.contains(item)) {
                plugin.topBarIcons.splice(i, 1);
                i--;
                continue;
            }
            const hasUnpin = window.siyuan.storage[Constants.LOCAL_PLUGINTOPUNPIN].includes(item.id);
            const submenu = [{
                id: hasUnpin ? "pin" : "unpin",
                icon: hasUnpin ? "iconPin" : "iconUnpin",
                label: hasUnpin ? window.siyuan.languages.pin : window.siyuan.languages.unpin,
                click() {
                    if (hasUnpin) {
                        window.siyuan.storage[Constants.LOCAL_PLUGINTOPUNPIN].splice(window.siyuan.storage[Constants.LOCAL_PLUGINTOPUNPIN].indexOf(item.id), 1);
                        item.classList.remove("fn__none");
                    } else {
                        window.siyuan.storage[Constants.LOCAL_PLUGINTOPUNPIN].push(item.id);
                        window.siyuan.storage[Constants.LOCAL_PLUGINTOPUNPIN] = Array.from(new Set(window.siyuan.storage[Constants.LOCAL_PLUGINTOPUNPIN]));
                        item.classList.add("fn__none");
                    }
                    setStorageVal(Constants.LOCAL_PLUGINTOPUNPIN, window.siyuan.storage[Constants.LOCAL_PLUGINTOPUNPIN]);
                    /// #if !MOBILE
                    setTabPosition(true);
                    /// #endif
                }
            }];
            if (hasSetting) {
                submenu.push({
                    id: "config",
                    icon: "iconSettings",
                    label: window.siyuan.languages.config,
                    click() {
                        plugin.openSetting();
                    },
                });
            }
            const itemLabel = target ? item.getAttribute("aria-label") : item.textContent.trim();
            if (!target) {
                submenu.push({
                    id: "play",
                    icon: "iconPlay",
                    label: itemLabel,
                    click() {
                        item.dispatchEvent(new CustomEvent("click"));
                        return true;
                    },
                });
            }
            const menuOption: IMenu = {
                id: item.id,
                icon: "iconInfo",
                label: itemLabel,
                click: target ? () => {
                    item.dispatchEvent(new CustomEvent("click"));
                } : undefined,
                type: "submenu",
                submenu
            };
            if (item.querySelector("use")) {
                menuOption.icon = item.querySelector("use").getAttribute("xlink:href").replace("#", "");
            } else {
                const svgElement = item.querySelector("svg").cloneNode(true) as HTMLElement;
                svgElement.classList.add("b3-menu__icon");
                menuOption.iconHTML = svgElement.outerHTML;
            }
            menu.addItem(menuOption);
            hasPlugin = true;
            hasTopBar = true;
        }
        if (!hasTopBar && hasSetting) {
            hasPlugin = true;
            menu.addItem({
                id: plugin.name,
                icon: "iconSettings",
                label: plugin.displayName,
                click() {
                    plugin.openSetting();
                }
            });
        }
    });
    if (!hasPlugin) {
        if (target) {
            window.siyuan.menus.menu.element.querySelector(".b3-menu__separator")?.remove();
        } else {
            menu.addItem({
                id: "emptyContent",
                iconHTML: "",
                type: "readonly",
                label: window.siyuan.languages.emptyContent,
            });
        }
    }
    if (target) {
        let rect = target.getBoundingClientRect();
        if (rect.width === 0) {
            rect = document.querySelector("#barMore").getBoundingClientRect();
        }
        menu.open({x: rect.right, y: rect.bottom, isLeft: true});
    } else {
        menu.fullscreen();
    }
};
