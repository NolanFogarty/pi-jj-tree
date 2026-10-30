/** jj-style conversation tree: /jj-tree [id-prefix]. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Role = "user" | "assistant";

interface Node {
	id: string;
	parentId: string | undefined;
	role: Role;
	text: string;
	raw: string;
	timestamp?: string | number;
	aborted: boolean;
	children: Node[];
}

interface Tree {
	roots: Node[];
	byId: Map<string, Node>;
}

interface Row {
	node: Node;
	col: number;
	/** Unstyled graph cell; may be "edge\nnode". */
	graph: string;
	/** Length of this id's shortest prefix that is unique among visible rows. */
	prefixLen: number;
	/** IDs represented by an expandable ~ row; never a navigation target. */
	hiddenIds?: string[];
}

function stripMarkdown(md: string): string {
	return md
		.replace(/```[\s\S]*?```/g, " [code] ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/^\s*([-*+]|\d+\.)\s+/gm, "")
		.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(\*|_)(.+?)\1/g, "$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function formatTimestamp(value: string | number | undefined): string {
	if (value === undefined) return "unknown date";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "unknown date";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function messageText(entry: any): string {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
}

function buildTree(ctx: ExtensionCommandContext, roles: Set<Role>): Tree {
	const entries = ctx.sessionManager.getEntries() as any[];
	const entryById = new Map(entries.map((e) => [e.id, e]));
	const byId = new Map<string, Node>();
	const roots: Node[] = [];

	const isVisible = (e: any) =>
		e?.type === "message" && roles.has(e.message?.role) && messageText(e).trim().length > 0;

	const visibleParent = (e: any): Node | undefined => {
		let p = e.parentId ? entryById.get(e.parentId) : undefined;
		while (p && !isVisible(p)) p = p.parentId ? entryById.get(p.parentId) : undefined;
		return p ? byId.get(p.id) : undefined;
	};

	for (const e of entries) {
		if (!isVisible(e)) continue;
		const raw = messageText(e).trim();
		const stop = e.message.stopReason;
		const node: Node = {
			id: e.id,
			parentId: undefined,
			role: e.message.role,
			text: stripMarkdown(raw) || "(empty)",
			raw,
			timestamp: e.message.timestamp ?? e.timestamp,
			aborted: e.message.role === "assistant" && !!stop && stop !== "stop" && stop !== "toolUse",
			children: [],
		};
		byId.set(e.id, node);
		const parent = visibleParent(e);
		if (parent) {
			node.parentId = parent.id;
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return { roots, byId };
}

// In user-only view, continue after the reply rather than the bare prompt.
function exchangeEnd(full: Tree, userId: string): string {
	let node = full.byId.get(userId);
	let last = userId;
	while (node && node.children[0]?.role === "assistant") {
		node = node.children[0];
		last = node.id;
	}
	return last;
}

function uniquePrefixLens(ids: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const id of ids) {
		let n = 1;
		while (n < id.length && ids.some((o) => o !== id && o.startsWith(id.slice(0, n)))) n++;
		out.set(id, n);
	}
	return out;
}

function layout(tree: Tree, currentId: string | undefined, onPath: Set<string>): Row[] {
	// Keep the active path in column 0; side branches open fresh columns.
	const order: { node: Node; col: number }[] = [];
	let nextCol = 0;
	const walk = (node: Node, col: number) => {
		order.push({ node, col });
		const kids = [...node.children].sort((a, b) => Number(onPath.has(b.id)) - Number(onPath.has(a.id)));
		kids.forEach((kid, i) => walk(kid, i === 0 ? col : ++nextCol));
	};
	tree.roots.forEach((root, i) => walk(root, i === 0 ? 0 : ++nextCol));

	// Emit children before parents, prioritizing the active branch among
	// available leaves. Reversing DFS put side branches above @ and could
	// draw an ancestor before a side branch had joined it.
	const positions = new Map(order.map((item) => [item.node.id, item]));
	const pending = new Map(order.map(({ node }) => [node.id, node.children.length]));
	const ready = order.filter(({ node }) => node.children.length === 0);
	const sorted: typeof order = [];
	while (ready.length) {
		ready.sort((a, b) =>
			Number(b.node.id === currentId) - Number(a.node.id === currentId) ||
			Number(onPath.has(b.node.id)) - Number(onPath.has(a.node.id)) || a.col - b.col);
		const item = ready.shift()!;
		sorted.push(item);
		const parentId = item.node.parentId;
		if (parentId && pending.has(parentId)) {
			const remaining = pending.get(parentId)! - 1;
			pending.set(parentId, remaining);
			if (remaining === 0) ready.push(positions.get(parentId)!);
		}
	}
	order.splice(0, order.length, ...sorted);

	const maxCol = nextCol;
	const prefixLens = uniquePrefixLens(order.map((o) => o.node.id));
	// Columns with an edge running downward, and the parent id each is waiting to meet.
	const open = new Map<number, string | undefined>();
	const rows: Row[] = [];

	for (const { node, col } of order) {
		// Side columns whose parent is this node merge into it here: ├─┴─╯
		const merging = [...open].filter(([c, pid]) => c !== col && pid === node.id).map(([c]) => c);
		let edgeLine = "";
		if (merging.length > 0) {
			const hi = Math.max(col, ...merging);
			const lo = Math.min(col, ...merging);
			for (let c = 0; c <= maxCol; c++) {
				if (c === col) edgeLine += open.has(c) ? "├─" : "╭─";
				else if (merging.includes(c)) edgeLine += c === hi ? "╯ " : "┴─";
				else if (c > lo && c < hi) edgeLine += "──";
				else edgeLine += open.has(c) ? "│ " : "  ";
			}
			for (const c of merging) open.delete(c);
		}

		const symbol =
			node.id === currentId ? "@"
			: node.aborted ? "×"
			: node.parentId === undefined ? "◆"
			: "○";

		let nodeLine = "";
		for (let c = 0; c <= maxCol; c++) nodeLine += c === col ? `${symbol} ` : open.has(c) ? "│ " : "  ";

		if (node.parentId === undefined) open.delete(col);
		else open.set(col, node.parentId);

		const graph = (edgeLine ? edgeLine.trimEnd() + "\n" : "") + nodeLine.trimEnd();
		rows.push({ node, col, graph, prefixLen: prefixLens.get(node.id) ?? node.id.length });
	}
	return rows;
}

/** Collapse only linear stretches after a fork. Keep graph junctions intact. */
function compactRows(
	rows: Row[], tree: Tree, currentId: string | undefined, expanded: Set<string>,
	forkIds = new Set<string>(), labels = new Set<string>(),
): Row[] {
	const eligible = new Set<string>();
	const visit = (node: Node, afterFork: boolean) => {
		if (!labels.has(node.id) && afterFork && node.children.length === 1 && !forkIds.has(node.id) && node.id !== currentId && !expanded.has(node.id)) {
			eligible.add(node.id);
		}
		for (const child of node.children) visit(child, afterFork || node.children.length > 1 || forkIds.has(node.id));
	};
	for (const root of tree.roots) visit(root, false);

	const result: Row[] = [];
	for (let i = 0; i < rows.length;) {
		const row = rows[i];
		if (!eligible.has(row.node.id) || row.graph.includes("\n")) {
			result.push(row);
			i++;
			continue;
		}
		const hiddenIds = [row.node.id];
		let previous = row;
		i++;
		while (i < rows.length) {
			const next = rows[i];
			if (!eligible.has(next.node.id) || next.col !== row.col || next.graph.includes("\n") ||
				previous.node.parentId !== next.node.id) break;
			hiddenIds.push(next.node.id);
			previous = next;
			i++;
		}
		result.push({ ...row, graph: row.graph.replace(/[○◆×@]/, "~"), hiddenIds });
	}
	return result;
}

type Action = { kind: "new"; id: string } | { kind: "edit"; node: Node } | null;

export default function branchNavigator(pi: ExtensionAPI) {
	pi.registerCommand("jj-tree", {
		description: "jj-style log of conversation branches (/jj-tree [id-prefix])",
		handler: async (args, ctx) => {
			const ALL: Set<Role> = new Set(["user", "assistant"]);
			const full = buildTree(ctx, ALL);
			if (full.roots.length === 0) {
				ctx.ui.notify("No messages in this session yet", "info");
				return;
			}

			const branch = ctx.sessionManager.getBranch() as any[];
			const onPath = new Set<string>(branch.map((e) => e.id));

			const prefix = args.trim().toLowerCase();
			if (prefix) {
				const matches = [...full.byId.keys()].filter((id) => id.startsWith(prefix));
				if (matches.length === 1) {
					const node = full.byId.get(matches[0])!;
					const target = node.role === "user" ? exchangeEnd(full, node.id) : node.id;
					const r = await ctx.navigateTree(target);
					if (r.cancelled) ctx.ui.notify("Navigation cancelled", "info");
				} else {
					ctx.ui.notify(
						matches.length === 0 ? `No entry matches "${prefix}"` : `"${prefix}" is ambiguous (${matches.length} matches)`,
						"error",
					);
				}
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("/jj-tree requires interactive mode", "error");
				return;
			}

			const action = await ctx.ui.custom<Action>((tui, theme, _kb, done) => {
				let showAssistant = false;
				let compact = false;
				const expanded = new Set<string>();
				const prefixLens = uniquePrefixLens([...full.byId.keys()]);
				let tree!: Tree;
				let rows!: Row[];
				let currentId: string | undefined;
				let cursor = 0;
				let scroll = 0;
				let labelInput: Input | undefined;
				let focused = true;
				let idQuery: string | null = null; // non-null while in ":" prompt
				let cache: { width: number; lines: string[] } | undefined;

				const invalidate = () => {
					cache = undefined;
				};

				const rebuild = (keepId?: string) => {
					tree = showAssistant ? full : buildTree(ctx, new Set<Role>(["user"]));
					// `@` = newest visible message on the active path.
					currentId = [...branch].reverse().find((e) => tree.byId.has(e.id))?.id;
					rows = layout(tree, currentId, onPath);
					// Include hidden messages in prefix uniqueness, so : and CLI jumps agree.
					for (const row of rows) row.prefixLen = prefixLens.get(row.node.id)!;
					if (compact) {
						// Preserve the nearest visible ancestor of hidden assistant forks.
						const forkIds = new Set<string>();
						for (const node of full.byId.values()) {
							if (node.children.length < 2) continue;
							let ancestor: Node | undefined = node;
							while (ancestor && !tree.byId.has(ancestor.id)) {
								ancestor = ancestor.parentId ? full.byId.get(ancestor.parentId) : undefined;
							}
							if (ancestor) forkIds.add(ancestor.id);
						}
						const labeled = new Set([...tree.byId.keys()].filter((id) => ctx.sessionManager.getLabel(id)));
						rows = compactRows(rows, tree, currentId, expanded, forkIds, labeled);
					}
					scroll = 0;
					const want = keepId && tree.byId.has(keepId) ? keepId : currentId;
					cursor = Math.max(0, rows.findIndex((r) => r.node.id === want));
					invalidate();
				};
				rebuild();

				const move = (delta: number) => {
					cursor = Math.min(rows.length - 1, Math.max(0, cursor + delta));
					invalidate();
					tui.requestRender();
				};
				const page = () => Math.max(3, tui.terminal.rows - 6);

				const styleGraph = (g: string, selected: boolean) =>
					g
						.replace(/[@○◆×~]/, (s) =>
							s === "@" ? theme.fg("success", theme.bold(s))
							: s === "×" ? theme.fg("error", s)
							: selected ? theme.fg("accent", s)
							: theme.fg("muted", s),
						)
						.replace(/[│├╭╯┴─]+/g, (e) => theme.fg("dim", e));

				const styleId = (row: Row) => {
					const id = row.node.id;
					const n = row.prefixLen;
					// Use jj's terminal palette, independent of Pi's theme.
					const color = row.node.id === currentId ? 95 : 35;
					return `\x1b[1;${color}m${id.slice(0, n)}\x1b[0m` +
						`\x1b[90m${id.slice(n)}\x1b[0m`;
				};

				/** h/l: jump to the leaf (newest row) of the adjacent column. */
				const moveColumn = (delta: number) => {
					if (!rows[cursor]) return;
					const col = rows[cursor].col + delta;
					const i = rows.findIndex((r) => r.col === col); // rows are newest-first
					if (i === -1) return;
					cursor = i;
					invalidate();
					tui.requestRender();
				};

				const jumpToPrefix = (q: string) => {
					if (!q) return false;
					const matches = [...full.byId.keys()].filter((id) => id.startsWith(q));
					if (matches.length === 1) {
						const id = matches[0];
						if (full.byId.get(id)!.role === "assistant") showAssistant = true;
						const stretch = rows.find((row) => row.hiddenIds?.includes(id));
						for (const hidden of stretch?.hiddenIds ?? [id]) expanded.add(hidden);
						rebuild(id);
						return true;
					}
					return false;
				};

				return {
					get focused() { return focused; },
					set focused(value: boolean) {
						focused = value;
						if (labelInput) labelInput.focused = value;
					},
					render(width: number): string[] {
						if (cache && cache.width === width) return cache.lines;

						if (!rows.length) return [truncateToWidth("No user queries. Ctrl+A shows assistant messages; q closes.", width)];
						const height = Math.max(1, page() - (labelInput ? 2 : 0));
						const rowLines = rows.map((r) => r.graph.split("\n").length + (r.hiddenIds ? 0 : 1));
						const startLine = (i: number) => rowLines.slice(0, i).reduce((a, b) => a + b, 0);
						if (startLine(cursor) < scroll) scroll = startLine(cursor);
						if (startLine(cursor) + rowLines[cursor] > scroll + height)
							scroll = startLine(cursor) + rowLines[cursor] - height;
						scroll = Math.max(0, scroll);

						const out: string[] = [];
						for (let i = 0; i < rows.length; i++) {
							const row = rows[i];
							const selected = i === cursor;
							const parts = row.graph.split("\n");
							const nodeCell = parts[parts.length - 1];
							const edgeCell = parts.length > 1 ? parts[0] : undefined;
							if (edgeCell) out.push(truncateToWidth("  " + styleGraph(edgeCell, false), width));

							const cursorMark = selected ? theme.fg("accent", "› ") : "  ";
							if (row.hiddenIds) {
								const count = row.hiddenIds.length;
								const noun = showAssistant ? "messages" : "queries";
								out.push(truncateToWidth(cursorMark + styleGraph(nodeCell, selected) +
									"  " + theme.fg("muted", `${count} ${noun} hidden — enter to expand`), width));
								continue;
							}
							const roleText = row.node.role === "user" ? "user" : "assistant";
							// jj's author/email attribution uses terminal yellow.
							const label = row.node.role === "user"
								? `\x1b[33m${roleText}\x1b[0m`
								: theme.fg("success", roleText);
							const entryLabel = ctx.sessionManager.getLabel(row.node.id);
							const labelText = entryLabel ? `[${entryLabel.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}]` : "";
							const coloredLabel = entryLabel
								? ` \x1b[${row.node.id === currentId ? 94 : 34}m${labelText}\x1b[0m` : "";
							const cyan = row.node.id === currentId ? 96 : 36;
							const date = `\x1b[${cyan}m${formatTimestamp(row.node.timestamp)}\x1b[0m`;
							const head = cursorMark + styleGraph(nodeCell, selected) + " " + styleId(row) + " " + label + " " + date + coloredLabel;
							out.push(truncateToWidth(head, width));

							// Continue graph edges through the description line.
							const continuation = nodeCell.replace(/[@○◆×]/, row.node.parentId ? "│" : " ");
							const descriptionPrefix = "  " + styleGraph(continuation, false) + " ";
							let body = truncateToWidth(row.node.text,
								Math.max(0, width - visibleWidth(descriptionPrefix)));
							if (selected) body = theme.bold(body);
							out.push(truncateToWidth(descriptionPrefix + body, width));
						}

						const header =
							theme.fg("accent", theme.bold("Branches")) +
							theme.fg("dim", `  ${cursor + 1}/${rows.length}`) +
							theme.fg("dim", showAssistant ? "  [user+assistant]" : "  [user only]") +
							theme.fg("dim", compact ? " [compact]" : " [all]");
						const footer =
							idQuery !== null
								? theme.fg("muted", "jump to id: ") + theme.fg("warning", idQuery) + theme.fg("dim", "▏")
								: theme.fg(
										"dim",
										"^a assistant · ^o compact/all · Shift+L label · : jump id · enter new · e edit · q cancel",
									);
						const lines = labelInput
							? [header, ...out.slice(scroll, scroll + height),
								theme.fg("muted", "Label — enter saves, empty removes, esc cancels"), ...labelInput.render(width)]
							: [header, ...out.slice(scroll, scroll + height), footer];
						cache = { width, lines: lines.map((l) => truncateToWidth(l, width)) };
						return cache.lines;
					},

					handleInput(data: string): void {
						if (labelInput) {
							labelInput.handleInput(data);
							invalidate();
							tui.requestRender();
							return;
						}
						if (idQuery !== null) {
							if (matchesKey(data, "escape")) idQuery = null;
							else if (matchesKey(data, "return")) {
								if (jumpToPrefix(idQuery)) idQuery = null;
							} else if (matchesKey(data, "backspace")) idQuery = idQuery.slice(0, -1);
							else if (/^[0-9a-f]$/i.test(data)) {
								idQuery += data.toLowerCase();
								if (jumpToPrefix(idQuery)) idQuery = null;
							}
							invalidate();
							tui.requestRender();
							return;
						}

						// Decode both legacy and kitty keyboard-protocol input.
						const is = (...keys: string[]) => keys.some((k) => matchesKey(data, k as any));

						if (is("shift+l")) {
							const row = rows[cursor];
							if (!row || row.hiddenIds) return;
							const id = row.node.id;
							labelInput = new Input();
							labelInput.focused = focused;
							labelInput.setValue(ctx.sessionManager.getLabel(id) ?? "");
							labelInput.onSubmit = (value) => {
								pi.setLabel(id, value.trim() || undefined);
								labelInput = undefined;
								rebuild(id);
							};
							labelInput.onEscape = () => { labelInput = undefined; };
							invalidate();
							return tui.requestRender();
						}
						if (is("j", "down")) return move(1);
						if (is("k", "up")) return move(-1);
						if (is("h", "left")) return moveColumn(-1);
						if (is("l", "right")) return moveColumn(1);
						if (is("g")) return move(-rows.length);
						if (is("shift+g")) return move(rows.length);
						if (is("ctrl+d")) return move(Math.floor(page() / 2));
						if (is("ctrl+u")) return move(-Math.floor(page() / 2));
						if (is("ctrl+f")) return move(page());
						if (is("ctrl+b")) return move(-page());
						if (is("ctrl+o")) {
							compact = !compact;
							if (compact) expanded.clear();
							rebuild(rows[cursor]?.node.id);
							return tui.requestRender();
						}
						if (is("ctrl+a")) {
							showAssistant = !showAssistant;
							rebuild(rows[cursor]?.node.id);
							return tui.requestRender();
						}
						if (data === ":") {
							idQuery = "";
							invalidate();
							return tui.requestRender();
						}
						if (is("return")) {
							const row = rows[cursor];
							if (!row) return;
							if (row.hiddenIds) {
								for (const id of row.hiddenIds) expanded.add(id);
								rebuild(row.node.id);
								return tui.requestRender();
							}
							const node = rows[cursor].node;
							const id = node.role === "user" && !showAssistant ? exchangeEnd(full, node.id) : node.id;
							return done({ kind: "new", id });
						}
						if (is("e")) {
							if (!rows[cursor] || rows[cursor].hiddenIds) return;
							const node = rows[cursor].node;
							if (node.role !== "user") return;
							return done({ kind: "edit", node: full.byId.get(node.id)! });
						}
						if (is("q", "escape")) return done(null);
					},

					invalidate,
				};
			});

			if (!action) return;

			const leafId = [...branch].reverse().find((e) => full.byId.has(e.id))?.id;

			if (action.kind === "new") {
				if (action.id === leafId) return;
				const r = await ctx.navigateTree(action.id);
				if (r.cancelled) ctx.ui.notify("Navigation cancelled", "info");
				return;
			}

			// "edit": move @ to the parent of the user message and reload its text.
			const parentId = action.node.parentId;
			if (parentId && parentId !== leafId) {
				const r = await ctx.navigateTree(parentId);
				if (r.cancelled) {
					ctx.ui.notify("Navigation cancelled", "info");
					return;
				}
			}
			ctx.ui.setEditorText(action.node.raw);
		},
	});
}
