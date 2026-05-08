import {Context} from '../core/context';
import {Bounds} from '../css/layout/bounds';
import type {TextBounds} from '../css/layout/text';
import type {ElementContainer} from '../dom/element-container';
import type {TextContainer} from '../dom/text-container';
import type {pageConfigOptions, PageConfigFn} from './canvas/pdf-renderer';

const PAGE_TOP_OFFSET = 10;
const MAX_RECURSION_DEPTH = 1000;

const resolvePageConfig = (
    pageConfig: pageConfigOptions | PageConfigFn | undefined,
    pageNum: number,
    totalPages: number
): pageConfigOptions | null => {
    if (typeof pageConfig === 'function') return pageConfig(pageNum, totalPages);
    return pageConfig ?? null;
};

class PageOffsetTracker {
    private offsets: number[] = [];
    private maxOffset = 0;

    getPageOffset(pageIndex: number): number {
        for (let i = pageIndex; i >= 0; i--) {
            const v = this.offsets[i];
            if (v !== undefined) return v;
        }
        return 0;
    }

    getPreviousPageOffset(pageIndex: number): number {
        for (let i = pageIndex - 1; i >= 0; i--) {
            const v = this.offsets[i];
            if (v !== undefined) return v;
        }
        return 0;
    }

    updatePageOffset(pageIndex: number, delta: number): number {
        const previousOffset = this.getPreviousPageOffset(pageIndex);
        const nextOffset = previousOffset + delta;
        const currentOffset = this.offsets[pageIndex] ?? previousOffset;

        if (nextOffset > currentOffset) {
            this.offsets[pageIndex] = nextOffset;
            if (nextOffset > this.maxOffset) this.maxOffset = nextOffset;
            return nextOffset;
        }
        return currentOffset;
    }

    get total(): number {
        return this.maxOffset;
    }

    reset(): void {
        this.offsets.length = 0;
        this.maxOffset = 0;
    }
}

interface PageContext {
    offsetTracker: PageOffsetTracker;
    activePageHeight: number;
    pageMarginTop: number;
    breakStartPageMap: Map<ElementContainer, number>;
}

const cloneContainerShallow = (src: ElementContainer): ElementContainer => {
    const c = Object.create(Object.getPrototypeOf(src)) as Record<string, unknown>;
    const srcObj = src as unknown as Record<string, unknown>;
    for (const key of Object.keys(srcObj)) {
        if (key === 'elements' || key === 'bounds' || key === 'styles' || key === 'textNodes') continue;
        c[key] = srcObj[key];
    }
    c.context = (src as unknown as {context: Context}).context;
    c.styles = Object.assign(Object.create(Object.getPrototypeOf(src.styles)), src.styles);
    c.textNodes = src.textNodes;
    c.flags = src.flags;
    c.bounds = new Bounds(src.bounds.left, src.bounds.top, src.bounds.width, src.bounds.height);
    c.elements = [];
    return c as unknown as ElementContainer;
};

const cloneTextContainerShallow = (src: TextContainer): TextContainer => {
    const c = Object.create(Object.getPrototypeOf(src)) as Record<string, unknown>;
    c.text = (src as unknown as {text: string}).text;
    c.textBounds = [] as TextBounds[];
    return c as unknown as TextContainer;
};

const computeMaxBottom = (node: ElementContainer, depth = 0): number => {
    if (depth > MAX_RECURSION_DEPTH) {
        throw new Error('Maximum recursion depth exceeded in computeMaxBottom');
    }
    let maxBottom = node.bounds.top + node.bounds.height;
    for (const tn of node.textNodes) {
        for (const tb of tn.textBounds) {
            const b = tb.bounds.top + tb.bounds.height;
            if (b > maxBottom) maxBottom = b;
        }
    }
    for (const el of node.elements) {
        const b = computeMaxBottom(el, depth + 1);
        if (b > maxBottom) maxBottom = b;
    }
    return maxBottom;
};

const filterTextNodesForPage = (
    container: ElementContainer,
    pageStart: number,
    pageEnd: number,
    ctx: PageContext,
    pageIndex: number
): TextContainer[] => {
    const result: TextContainer[] = [];

    for (const tc of container.textNodes) {
        const filtered: TextBounds[] = [];

        for (const tb of tc.textBounds) {
            const activePageOffset = ctx.offsetTracker.getPageOffset(pageIndex);
            const prevPageOffset = ctx.offsetTracker.getPreviousPageOffset(pageIndex);
            let top = tb.bounds.top + activePageOffset;
            let bottom = tb.bounds.top + tb.bounds.height + activePageOffset;
            const intersects = bottom > pageStart && top < pageEnd;
            const crossesToNextPage = bottom > pageEnd;
            if (intersects && !crossesToNextPage) {
                let offsetNum = 0;
                if (top < pageStart) {
                    if (prevPageOffset || pageIndex > 1) {
                        const prevPageStart = pageStart - ctx.activePageHeight;
                        const prevPageEnd = pageEnd - ctx.activePageHeight;
                        const prevTop = tb.bounds.top + prevPageOffset;
                        const prevBottom = tb.bounds.top + tb.bounds.height + prevPageOffset;
                        const prevIntersects = prevBottom > prevPageStart && prevTop < prevPageEnd;
                        const prevCrossesToNextPage = prevBottom > prevPageEnd;
                        if (prevIntersects && !prevCrossesToNextPage) {
                            continue;
                        }
                    }
                    offsetNum = pageStart - top + PAGE_TOP_OFFSET;
                    const nextOffset = ctx.offsetTracker.updatePageOffset(pageIndex, offsetNum);
                    const appliedOffset = nextOffset - activePageOffset;
                    bottom += appliedOffset;
                    top += appliedOffset;
                }
                const visibleTop = Math.max(top, pageStart);
                const visibleBottom = Math.min(bottom, pageEnd);
                const newTop = visibleTop - pageStart;
                const newHeight = Math.max(0, visibleBottom - visibleTop);
                const nb = new Bounds(tb.bounds.left, newTop + ctx.pageMarginTop, tb.bounds.width, newHeight);
                filtered.push({text: (tb as unknown as {text: string}).text, bounds: nb} as TextBounds);
            }
        }
        if (filtered.length > 0) {
            const clone = cloneTextContainerShallow(tc);
            (clone as unknown as Record<string, unknown>).textBounds = filtered;
            result.push(clone);
        }
    }

    return result;
};

const filterElementForPage = (
    container: ElementContainer,
    pageStart: number,
    pageEnd: number,
    ctx: PageContext,
    pageIndex: number,
    depth = 0
): ElementContainer | null => {
    if (depth > MAX_RECURSION_DEPTH) {
        throw new Error('Maximum recursion depth exceeded in filterElementForPage');
    }
    const containerPageOffset = ctx.offsetTracker.getPageOffset(pageIndex);
    const top = container.bounds.top + containerPageOffset;
    const bottom = container.bounds.top + container.bounds.height + containerPageOffset;

    const breakStartPage = ctx.breakStartPageMap.get(container);
    if (breakStartPage !== undefined && pageIndex < breakStartPage) {
        return null;
    }

    if (container.pageBreak && breakStartPage === undefined && bottom > pageStart && top < pageEnd) {
        const offsetNum = pageEnd - top + PAGE_TOP_OFFSET;
        ctx.offsetTracker.updatePageOffset(pageIndex, offsetNum);
        ctx.breakStartPageMap.set(container, pageIndex + 1);
        return null;
    }

    if (container.divisionDisable && bottom > pageEnd && top < pageEnd) {
        const offsetNum = pageEnd - top + PAGE_TOP_OFFSET;
        ctx.offsetTracker.updatePageOffset(pageIndex, offsetNum);
        return null;
    }

    const children: ElementContainer[] = [];
    const textNodes = filterTextNodesForPage(container, pageStart, pageEnd, ctx, pageIndex);
    for (const child of container.elements) {
        const part = filterElementForPage(child, pageStart, pageEnd, ctx, pageIndex, depth + 1);
        if (part) children.push(part);
    }
    const visibleTop = Math.max(top, pageStart);
    const visibleBottom = Math.min(bottom, pageEnd);
    const newHeight = Math.max(0, visibleBottom - visibleTop);
    const hasContent = children.length > 0 || textNodes.length > 0 || newHeight > 0;
    if (!hasContent) return null;
    const clone = cloneContainerShallow(container) as unknown as Record<string, unknown>;
    clone.elements = children;
    clone.textNodes = textNodes;
    const newTop = visibleTop >= pageStart ? visibleTop - pageStart : 0;
    clone.bounds = new Bounds(container.bounds.left, newTop + ctx.pageMarginTop, container.bounds.width, newHeight);
    return clone as unknown as ElementContainer;
};

export const paginateNode = (
    root: ElementContainer,
    pageHeight: number,
    initialOffset = 0,
    totalHeight?: number,
    pageConfig?: pageConfigOptions | PageConfigFn
): ElementContainer[] => {
    if (initialOffset < 0) initialOffset = 0;

    const offsetTracker = new PageOffsetTracker();
    const breakStartPageMap = new Map<ElementContainer, number>();

    const maxBottom = totalHeight != null && totalHeight >= 0 ? totalHeight : computeMaxBottom(root);

    // Compute default active page height for initial page count estimation
    const defaultCfg = resolvePageConfig(pageConfig, 1, 1);
    const defaultMt = Math.max(0, defaultCfg?.header?.height ?? 0);
    const defaultMb = Math.max(0, defaultCfg?.footer?.height ?? 0);
    const defaultAph = pageHeight - defaultMt - defaultMb;

    if (!Number.isFinite(defaultAph) || defaultAph <= 0) {
        throw new Error(`Invalid page height: header and footer exceed the available page height`);
    }

    let totalPages = Math.max(1, Math.ceil((maxBottom - initialOffset) / defaultAph));
    const pages: ElementContainer[] = [];
    let contentPos = initialOffset;

    for (let i = 0; i < totalPages; i++) {
        const cfg = resolvePageConfig(pageConfig, i + 1, totalPages);
        const mt = Math.max(0, cfg?.header?.height ?? 0);
        const mb = Math.max(0, cfg?.footer?.height ?? 0);
        const aph = pageHeight - mt - mb;

        if (!Number.isFinite(aph) || aph <= 0) {
            throw new Error(`Invalid page height on page ${i + 1}: header and footer exceed the available page height`);
        }

        const pageStart = contentPos;
        const pageEnd = pageStart + aph;

        const ctx: PageContext = {
            offsetTracker,
            activePageHeight: aph,
            pageMarginTop: mt,
            breakStartPageMap
        };

        const pageRoot = filterElementForPage(root, pageStart, pageEnd, ctx, i);
        if (pageRoot) pages.push(pageRoot);

        contentPos = pageEnd;

        const recalculatedPages = Math.max(1, Math.ceil((maxBottom + offsetTracker.total - initialOffset) / defaultAph));
        if (recalculatedPages > totalPages) {
            totalPages = recalculatedPages;
        }
    }
    return pages;
};
