const BACK_SELECTOR = '[data-float-back], button[aria-label^="返回"], button[aria-label="上一步"]';
const BACKDROP_SELECTOR = [
    ".modal-overlay", '[data-ui="modal"]', ".rb-modal-mask", ".folder-overlay",
    ".xhs-modal-backdrop", ".cp-black-market-modal", ".chat-custom-app-layer",
    ".chat-html-overlay", ".music-settings-modal-overlay", ".music-queue-overlay",
    ".music-playlist-picker-overlay", ".feed-comment-modal-backdrop",
].join(", ");
const MODAL_SELECTOR = `${BACKDROP_SELECTOR}, [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]`;

/** Hidden cached rooms and controls covered by another page must not receive back. */
function isExposed(element: HTMLElement, document: Document): boolean {
    const view = document.defaultView;
    if (!view || !element.getClientRects().length) return false;
    const style = view.getComputedStyle(element);
    if (style.visibility !== "visible" || style.display === "none") return false;
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit !== null && element.contains(hit);
}

function findControl(scope: ParentNode, selector: string, document: Document): HTMLElement | undefined {
    return Array.from(scope.querySelectorAll<HTMLElement>(selector))
        .filter(element => !element.matches(":disabled, [aria-disabled='true']") && isExposed(element, document))
        .at(-1);
}

/** Reuse one existing back/cancel handler; never submit, reload, or request cloud data. */
export function handleAndroidBack(document: Document): boolean {
    const modal = Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR))
        .filter(element => isExposed(element, document))
        .at(-1);
    if (modal) {
        // A wizard's previous-step button takes precedence over closing its editor.
        const previous = findControl(modal, BACK_SELECTOR, document);
        const close = findControl(modal, 'button[aria-label^="关闭"], button[aria-label="取消"]', document)
            ?? Array.from(modal.querySelectorAll<HTMLButtonElement>("button"))
                .filter(button => !button.matches(":disabled, [aria-disabled='true']") && isExposed(button, document)
                    && (/^(取消|关闭|返回)$/.test(button.textContent?.trim() ?? "") || button.querySelector(".lucide-x")))
                .at(-1);
        const target = previous ?? close ?? modal.closest<HTMLElement>(BACKDROP_SELECTOR);
        target?.click();
        // A busy/non-dismissible dialog still blocks navigation to the page underneath.
        return true;
    }
    const back = findControl(document, BACK_SELECTOR, document);
    if (!back) return false;
    back.click();
    return true;
}
