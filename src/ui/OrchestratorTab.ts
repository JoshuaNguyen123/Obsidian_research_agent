import type { OrchestratorSnapshotV1 } from "../orchestrator/types";
import {
  buildOrchestratorViewModel,
  formatOrchestratorElapsed,
  type OrchestratorAgentViewModel,
  type OrchestratorHandoffViewModel,
  type OrchestratorNodeViewModel,
  type OrchestratorViewLimits,
  type OrchestratorViewModel,
  type OrchestratorWorktreeViewModel,
} from "./orchestratorViewModel";

export type OrchestratorDetailsTargetKind =
  | "node"
  | "evidence"
  | "receipt"
  | "verification"
  | "worktree";

export interface OrchestratorDetailsTarget {
  kind: OrchestratorDetailsTargetKind;
  id?: string;
  nodeId?: string;
}

export interface OrchestratorTabOptions {
  limits?: Partial<OrchestratorViewLimits>;
  now?: () => number;
  onNavigateToRunDetails?: (target: OrchestratorDetailsTarget) => void;
  onNodeSelected?: (nodeId: string) => void;
}

interface OrchestratorRenderState {
  rootScrollTop: number;
  treeScrollTop: number;
  inspectorScrollTop: number;
  expandedNodes: Map<string, boolean>;
  focusKey: string | null;
}

/**
 * Native DOM renderer for the optional Orchestrator panel.
 *
 * It consumes only the persisted, structured snapshot. Model messages,
 * transcripts, and reasoning fields are intentionally not part of this API.
 */
export class OrchestratorTab {
  private readonly container: HTMLElement;
  private readonly options: OrchestratorTabOptions;
  private viewModel: OrchestratorViewModel | null = null;
  private selectedNodeId: string | null = null;
  private inspectorEl: HTMLElement | null = null;
  private treeEl: HTMLElement | null = null;
  private elapsedValueEl: HTMLElement | null = null;
  private elapsedTimer: number | null = null;
  private elapsedTimerWindow: Window | null = null;
  private lastSnapshot: OrchestratorSnapshotV1 | null = null;
  private renderedRunId: string | null = null;
  private renderedSequence = -1;

  constructor(container: HTMLElement, options: OrchestratorTabOptions = {}) {
    this.container = container;
    this.options = options;
    this.container.classList.add(
      "agentic-researcher-orchestrator-panel",
      "agentic-researcher-tab-panel",
    );
  }

  render(snapshot: OrchestratorSnapshotV1): void {
    if (!this.shouldAcceptSnapshot(snapshot)) {
      return;
    }
    const priorState = this.captureRenderState();
    const viewModel = buildOrchestratorViewModel(snapshot, {
      limits: this.options.limits,
      now: this.options.now?.(),
    });
    this.lastSnapshot = snapshot;
    this.renderedRunId = snapshot.runId;
    this.renderedSequence = snapshot.sequence;
    this.viewModel = viewModel;
    this.selectedNodeId =
      this.selectedNodeId && viewModel.nodes[this.selectedNodeId]
        ? this.selectedNodeId
        : viewModel.selectedNodeId;

    this.elapsedValueEl = null;
    this.container.replaceChildren();
    const root = createElement("div", "agentic-researcher-orchestrator");
    root.dataset.runId = viewModel.runId;
    root.dataset.sequence = String(viewModel.sequence);
    this.container.appendChild(root);

    this.renderSummary(root, viewModel);
    this.renderTaskArea(root, viewModel);
    this.renderAgents(root, viewModel.agents, viewModel.compacted.agents);
    this.renderWorktrees(
      root,
      viewModel.worktrees,
      viewModel.compacted.worktrees,
    );
    this.renderHandoffs(
      root,
      viewModel.handoffs,
      viewModel.compacted.handoffs,
    );
    this.renderSourceLedger(root, viewModel);
    this.renderMerge(root, viewModel);
    this.restoreRenderState(priorState);
    this.configureElapsedTimer();
  }

  update(snapshot: OrchestratorSnapshotV1): void {
    this.render(snapshot);
  }

  renderEmpty(
    message = "No team run yet. Chat stays the landing tab. Deep research / sources / verify prompts, or an explicit code-team request with repository: <path>, use Lead + Worker here.",
  ): void {
    this.clearElapsedTimer();
    this.lastSnapshot = null;
    this.renderedRunId = null;
    this.renderedSequence = -1;
    this.viewModel = null;
    this.selectedNodeId = null;
    this.inspectorEl = null;
    this.treeEl = null;
    this.elapsedValueEl = null;
    this.container.replaceChildren();
    const root = createElement(
      "div",
      "agentic-researcher-orchestrator agentic-researcher-orchestrator-empty",
    );
    const section = createSection(root, "empty", "Orchestrator");
    section.appendChild(placeholder(message));
    this.container.appendChild(root);
  }

  destroy(): void {
    this.clearElapsedTimer();
    this.viewModel = null;
    this.selectedNodeId = null;
    this.inspectorEl = null;
    this.treeEl = null;
    this.elapsedValueEl = null;
    this.lastSnapshot = null;
    this.renderedRunId = null;
    this.renderedSequence = -1;
    this.container.replaceChildren();
  }

  private shouldAcceptSnapshot(snapshot: OrchestratorSnapshotV1): boolean {
    return (
      this.renderedRunId !== snapshot.runId ||
      snapshot.sequence > this.renderedSequence
    );
  }

  private captureRenderState(): OrchestratorRenderState | null {
    const root = this.container.querySelector<HTMLElement>(
      ".agentic-researcher-orchestrator",
    );
    if (!root) return null;
    const expandedNodes = new Map<string, boolean>();
    for (const element of Array.from(
      root.querySelectorAll<HTMLDetailsElement>(
        ".agentic-researcher-orchestrator-tree-node[data-node-id]",
      ),
    )) {
      const nodeId = element.dataset.nodeId;
      if (nodeId) expandedNodes.set(nodeId, element.open);
    }
    const activeElement = this.container.ownerDocument.activeElement;
    const focusKey =
      activeElement instanceof HTMLElement && this.container.contains(activeElement)
        ? activeElement.dataset.orchestratorFocusKey ?? null
        : null;
    return {
      rootScrollTop: root.scrollTop,
      treeScrollTop: this.treeEl?.scrollTop ?? 0,
      inspectorScrollTop: this.inspectorEl?.scrollTop ?? 0,
      expandedNodes,
      focusKey,
    };
  }

  private restoreRenderState(state: OrchestratorRenderState | null): void {
    if (!state) return;
    for (const element of Array.from(
      this.container.querySelectorAll<HTMLDetailsElement>(
        ".agentic-researcher-orchestrator-tree-node[data-node-id]",
      ),
    )) {
      const nodeId = element.dataset.nodeId;
      if (nodeId && state.expandedNodes.has(nodeId)) {
        element.open = state.expandedNodes.get(nodeId) === true;
      }
    }
    const root = this.container.querySelector<HTMLElement>(
      ".agentic-researcher-orchestrator",
    );
    if (root) root.scrollTop = state.rootScrollTop;
    if (this.treeEl) this.treeEl.scrollTop = state.treeScrollTop;
    if (this.inspectorEl) this.inspectorEl.scrollTop = state.inspectorScrollTop;
    if (!state.focusKey) return;
    const focusTarget = Array.from(
      this.container.querySelectorAll<HTMLElement>(
        "[data-orchestrator-focus-key]",
      ),
    ).find(
      (element) => element.dataset.orchestratorFocusKey === state.focusKey,
    );
    focusTarget?.focus({ preventScroll: true });
  }

  private configureElapsedTimer(): void {
    this.clearElapsedTimer();
    if (!this.lastSnapshot || this.viewModel?.summary.status !== "running") {
      return;
    }
    const timerWindow = this.container.ownerDocument.defaultView;
    if (!timerWindow) return;
    this.elapsedTimerWindow = timerWindow;
    this.elapsedTimer = timerWindow.setInterval(() => {
      if (!this.container.isConnected) {
        this.clearElapsedTimer();
        return;
      }
      if (!this.lastSnapshot || !this.elapsedValueEl) return;
      this.elapsedValueEl.textContent = formatOrchestratorElapsed(
        this.lastSnapshot,
        this.options.now?.() ?? Date.now(),
      );
    }, 1_000);
  }

  private clearElapsedTimer(): void {
    if (this.elapsedTimer !== null) {
      this.elapsedTimerWindow?.clearInterval(this.elapsedTimer);
    }
    this.elapsedTimer = null;
    this.elapsedTimerWindow = null;
  }

  private renderSummary(root: HTMLElement, viewModel: OrchestratorViewModel) {
    const section = createSection(root, "summary", "Orchestrator");
    section.classList.add("agentic-researcher-orchestrator-summary");
    const header = section.querySelector<HTMLElement>(
      ".agentic-researcher-orchestrator-section-header",
    );
    header?.appendChild(statusBadge(viewModel.summary.status));

    const metrics = createElement(
      "div",
      "agentic-researcher-orchestrator-summary-grid",
    );
    section.appendChild(metrics);
    const summaryItems: Array<[string, string]> = [
      ["Mode", viewModel.summary.mode],
      ["Agents", String(viewModel.summary.agentCount)],
      [
        "Tasks",
        `${viewModel.summary.completeTasks}/${viewModel.summary.totalTasks}`,
      ],
      ["Evidence", String(viewModel.summary.evidenceCount)],
      ["Worktrees", String(viewModel.summary.worktreeCount)],
      ["Budget", viewModel.summary.budget],
      ["Elapsed", viewModel.summary.elapsed],
    ];
    for (const [label, value] of summaryItems) {
      const metric = createElement(
        "div",
        "agentic-researcher-orchestrator-summary-metric",
      );
      appendText(metric, "span", label, "agentic-researcher-orchestrator-kicker");
      const valueEl = appendText(
        metric,
        "strong",
        value,
        "agentic-researcher-orchestrator-value",
      );
      if (label === "Elapsed") {
        this.elapsedValueEl = valueEl;
      }
      metrics.appendChild(metric);
    }
  }

  private renderTaskArea(root: HTMLElement, viewModel: OrchestratorViewModel) {
    const section = createSection(root, "task-tree", "Task tree");
    const layout = createElement(
      "div",
      "agentic-researcher-orchestrator-task-layout",
    );
    section.appendChild(layout);

    this.treeEl = createElement(
      "div",
      "agentic-researcher-orchestrator-tree",
    );
    this.treeEl.setAttribute("role", "tree");
    this.treeEl.setAttribute("aria-label", "Orchestrator task tree");
    layout.appendChild(this.treeEl);

    if (viewModel.rootNodeIds.length === 0) {
      this.treeEl.appendChild(placeholder("No orchestrated tasks yet."));
    } else {
      const rendered = new Set<string>();
      for (const rootId of viewModel.rootNodeIds) {
        this.renderTreeNode(this.treeEl, rootId, 0, rendered);
      }
    }
    if (viewModel.compacted.treeNodes > 0) {
      this.treeEl.appendChild(
        compactedMarker(viewModel.compacted.treeNodes, "older task nodes"),
      );
    }

    this.inspectorEl = createElement(
      "aside",
      "agentic-researcher-orchestrator-inspector",
    );
    this.inspectorEl.setAttribute("aria-label", "Selected task details");
    layout.appendChild(this.inspectorEl);
    this.renderInspector();
  }

  private renderTreeNode(
    parent: HTMLElement,
    nodeId: string,
    depth: number,
    rendered: Set<string>,
  ) {
    const node = this.viewModel?.nodes[nodeId];
    if (!node || rendered.has(nodeId)) {
      return;
    }
    rendered.add(nodeId);

    const details = createElement(
      "details",
      "agentic-researcher-orchestrator-tree-node",
    ) as HTMLDetailsElement;
    details.dataset.nodeId = node.id;
    details.dataset.status = node.status;
    details.setAttribute("role", "treeitem");
    details.classList.toggle("is-selected", node.id === this.selectedNodeId);
    details.open =
      depth === 0 ||
      node.id === this.selectedNodeId ||
      ["running", "blocked", "waiting"].includes(node.status);

    const summary = createElement(
      "summary",
      "agentic-researcher-orchestrator-tree-summary",
    );
    summary.dataset.orchestratorFocusKey = `node:${node.id}`;
    appendText(
      summary,
      "span",
      node.title,
      "agentic-researcher-orchestrator-tree-title",
    );
    if (node.ownerLabel !== "Unassigned") {
      summary.appendChild(textBadge(node.ownerLabel));
    }
    if (node.worktreeId) {
      summary.appendChild(textBadge("WORKTREE", "is-worktree"));
    }
    summary.appendChild(statusBadge(node.status));
    summary.addEventListener("click", () => this.selectNode(node.id));
    details.appendChild(summary);

    if (node.childIds.length > 0 || node.omittedChildCount > 0) {
      const children = createElement(
        "div",
        "agentic-researcher-orchestrator-tree-children",
      );
      children.setAttribute("role", "group");
      for (const childId of node.childIds) {
        this.renderTreeNode(children, childId, depth + 1, rendered);
      }
      if (node.omittedChildCount > 0) {
        children.appendChild(
          compactedMarker(node.omittedChildCount, "child tasks"),
        );
      }
      details.appendChild(children);
    }
    parent.appendChild(details);
  }

  private selectNode(nodeId: string) {
    if (!this.viewModel?.nodes[nodeId]) {
      return;
    }
    this.selectedNodeId = nodeId;
    this.options.onNodeSelected?.(nodeId);
    const treeNodes = this.treeEl
      ? Array.from(
          this.treeEl.querySelectorAll<HTMLElement>(
            ".agentic-researcher-orchestrator-tree-node",
          ),
        )
      : [];
    for (const element of treeNodes) {
      element.classList.toggle("is-selected", element.dataset.nodeId === nodeId);
    }
    this.renderInspector();
  }

  private renderInspector() {
    if (!this.inspectorEl || !this.viewModel) {
      return;
    }
    this.inspectorEl.replaceChildren();
    const node = this.selectedNodeId
      ? this.viewModel.nodes[this.selectedNodeId]
      : undefined;
    if (!node) {
      this.inspectorEl.appendChild(placeholder("Select a task to inspect it."));
      return;
    }

    const heading = createElement(
      "div",
      "agentic-researcher-orchestrator-inspector-heading",
    );
    appendText(heading, "strong", "Node inspector");
    heading.appendChild(statusBadge(node.status));
    this.inspectorEl.appendChild(heading);
    appendText(
      this.inspectorEl,
      "div",
      node.title,
      "agentic-researcher-orchestrator-inspector-title",
    );

    this.appendInspectorRow("Assignment", node.ownerLabel);
    this.appendInspectorRow("Kind", node.kind);
    this.appendInspectorRow(
      "Dependencies",
      node.dependencyIds.length > 0 ? node.dependencyIds.join(", ") : "None",
    );
    this.appendInspectorRow("Proof contract", node.proofContract || "Not recorded");
    this.appendInspectorRow("Last action", node.lastAction || "No activity yet");
    if (node.resultSummary) {
      this.appendInspectorRow("Result", node.resultSummary);
    }
    if (node.blocker) {
      this.appendInspectorRow("Blocker", node.blocker, true);
    }
    if (node.worktreeId) {
      this.appendInspectorRow("Worktree", node.worktreeId);
    }
    this.appendLinkGroup("Evidence", node.evidenceIds, "evidence", node.id);
    this.appendLinkGroup("Receipts", node.receiptIds, "receipt", node.id);
    if (node.artifactLabels.length > 0) {
      this.appendInspectorRow("Artifacts", node.artifactLabels.join(" · "));
    }

    const action = actionButton(
      "View in Run Details",
      () => {
        this.navigate({ kind: "node", id: node.id, nodeId: node.id });
      },
      `node-details:${node.id}`,
    );
    action.classList.add("agentic-researcher-orchestrator-view-details");
    this.inspectorEl.appendChild(action);
  }

  private appendInspectorRow(label: string, value: string, isError = false) {
    if (!this.inspectorEl) {
      return;
    }
    const row = createElement(
      "div",
      "agentic-researcher-orchestrator-inspector-row",
    );
    row.classList.toggle("is-error", isError);
    appendText(row, "span", label, "agentic-researcher-orchestrator-kicker");
    appendText(row, "span", value, "agentic-researcher-orchestrator-inspector-value");
    this.inspectorEl.appendChild(row);
  }

  private appendLinkGroup(
    label: string,
    ids: string[],
    kind: "evidence" | "receipt",
    nodeId: string,
  ) {
    if (!this.inspectorEl || ids.length === 0) {
      return;
    }
    const row = createElement(
      "div",
      "agentic-researcher-orchestrator-inspector-row",
    );
    appendText(row, "span", label, "agentic-researcher-orchestrator-kicker");
    const links = createElement(
      "div",
      "agentic-researcher-orchestrator-link-list",
    );
    for (const id of ids) {
      links.appendChild(
        actionButton(
          id,
          () => this.navigate({ kind, id, nodeId }),
          `${kind}:${nodeId}:${id}`,
        ),
      );
    }
    row.appendChild(links);
    this.inspectorEl.appendChild(row);
  }

  private renderAgents(
    root: HTMLElement,
    agents: OrchestratorAgentViewModel[],
    compactedCount: number,
  ) {
    const section = createSection(root, "agents", "Agents");
    const grid = createElement(
      "div",
      "agentic-researcher-orchestrator-agent-grid",
    );
    section.appendChild(grid);
    if (agents.length === 0) {
      grid.appendChild(placeholder("No participants recorded."));
    }
    for (const agent of agents) {
      const card = createElement(
        "article",
        "agentic-researcher-orchestrator-agent-card",
      );
      card.dataset.agentId = agent.id;
      card.dataset.status = agent.status;
      const header = createElement(
        "div",
        "agentic-researcher-orchestrator-card-header",
      );
      appendText(header, "strong", agent.label);
      header.appendChild(statusBadge(agent.status));
      card.appendChild(header);
      appendText(card, "div", agent.role, "agentic-researcher-orchestrator-kicker");
      appendLabeledText(card, "Task", agent.task);
      appendLabeledText(card, "Budget", agent.budget);
      if (agent.lastAction) {
        appendLabeledText(card, "Last action", agent.lastAction);
      }
      if (agent.evidenceCount > 0) {
        appendLabeledText(card, "Evidence", String(agent.evidenceCount));
      }
      if (agent.handoffStatus) {
        appendLabeledText(card, "Handoff", agent.handoffStatus);
      }
      if (agent.resultSummary) {
        appendLabeledText(card, "Result", agent.resultSummary);
      }
      if (agent.blocker) {
        const blocker = appendLabeledText(card, "Blocker", agent.blocker);
        blocker.classList.add("is-error");
      }
      if (agent.currentNodeId) {
        card.appendChild(
          actionButton(
            "Inspect task",
            () => this.selectNode(agent.currentNodeId!),
            `agent-task:${agent.id}:${agent.currentNodeId}`,
          ),
        );
      }
      grid.appendChild(card);
    }
    if (compactedCount > 0) {
      section.appendChild(compactedMarker(compactedCount, "participants"));
    }
  }

  private renderWorktrees(
    root: HTMLElement,
    worktrees: OrchestratorWorktreeViewModel[],
    compactedCount: number,
  ) {
    const section = createSection(root, "worktrees", "Git worktrees");
    const list = createElement(
      "div",
      "agentic-researcher-orchestrator-worktree-list",
    );
    section.appendChild(list);
    if (worktrees.length === 0) {
      list.appendChild(placeholder("No coding worktrees for this run."));
    }
    for (const worktree of worktrees) {
      list.appendChild(this.renderWorktree(worktree));
    }
    if (compactedCount > 0) {
      section.appendChild(compactedMarker(compactedCount, "worktrees"));
    }
  }

  private renderWorktree(worktree: OrchestratorWorktreeViewModel): HTMLElement {
    const card = createElement(
      "article",
      "agentic-researcher-orchestrator-worktree-card",
    );
    card.dataset.worktreeId = worktree.id;
    card.dataset.status = worktree.status;
    const header = createElement(
      "div",
      "agentic-researcher-orchestrator-card-header",
    );
    appendText(header, "strong", worktree.branch);
    header.appendChild(statusBadge(worktree.status));
    card.appendChild(header);
    if (worktree.repositoryRoot) {
      appendLabeledText(card, "Repository", worktree.repositoryRoot);
    }
    if (worktree.baseBranch || worktree.baseSha) {
      appendLabeledText(
        card,
        "Pinned base",
        [worktree.baseBranch, shortSha(worktree.baseSha)].filter(Boolean).join(" @ "),
      );
    }
    if (worktree.path) {
      appendText(
        card,
        "div",
        worktree.path,
        "agentic-researcher-orchestrator-path",
      );
    }
    const metadata = [
      `${worktree.changedFiles} files changed`,
      worktree.baseSha ? `base ${shortSha(worktree.baseSha)}` : "",
      worktree.commitSha ? `commit ${shortSha(worktree.commitSha)}` : "",
    ].filter(Boolean);
    appendText(
      card,
      "div",
      metadata.join(" · "),
      "agentic-researcher-orchestrator-meta",
    );
    if (worktree.validationCommands.length > 0) {
      const validation = createElement(
        "ul",
        "agentic-researcher-orchestrator-command-list",
      );
      for (const command of worktree.validationCommands) {
        appendText(validation, "li", command);
      }
      card.appendChild(validation);
    }
    if (worktree.currentValidationCommand) {
      appendLabeledText(
        card,
        "Running",
        worktree.currentValidationCommand,
      );
    }
    if (worktree.changedFilePaths.length > 0) {
      appendLabeledText(
        card,
        "Changed",
        worktree.changedFilePaths.join(" · "),
      );
    }
    if (worktree.blocker) {
      const blocker = appendLabeledText(card, "Blocker", worktree.blocker);
      blocker.classList.add("is-error");
    }
    appendLabeledText(card, "Cleanup", worktree.cleanupState);
    card.appendChild(
      actionButton(
        "View verification",
        () =>
          this.navigate({
            kind: "worktree",
            id: worktree.id,
            nodeId: worktree.taskId || undefined,
          }),
        `worktree:${worktree.id}`,
      ),
    );
    return card;
  }

  private renderHandoffs(
    root: HTMLElement,
    handoffs: OrchestratorHandoffViewModel[],
    compactedCount: number,
  ) {
    const section = createSection(root, "handoffs", "Handoffs");
    const list = createElement(
      "div",
      "agentic-researcher-orchestrator-handoff-list",
    );
    section.appendChild(list);
    if (handoffs.length === 0) {
      list.appendChild(placeholder("No worker handoffs yet."));
    }
    for (const handoff of handoffs) {
      const card = createElement(
        "article",
        "agentic-researcher-orchestrator-handoff-card",
      );
      card.dataset.handoffId = handoff.id;
      const header = createElement(
        "div",
        "agentic-researcher-orchestrator-card-header",
      );
      appendText(
        header,
        "strong",
        `${handoff.fromAgentId || "Worker"} → ${handoff.toAgentId || "Lead"}`,
      );
      header.appendChild(statusBadge(handoff.status));
      card.appendChild(header);
      if (handoff.summary) {
        appendText(
          card,
          "div",
          handoff.summary,
          "agentic-researcher-orchestrator-card-copy",
        );
      }
      appendText(
        card,
        "div",
        `${handoff.sourceIds.length} sources · ${handoff.evidenceIds.length} evidence items${
          handoff.confidence ? ` · ${handoff.confidence} confidence` : ""
        }`,
        "agentic-researcher-orchestrator-meta",
      );
      if (handoff.unresolvedQuestions.length > 0) {
        appendLabeledText(
          card,
          "Unresolved",
          handoff.unresolvedQuestions.join(" · "),
        );
      }
      if (handoff.stopReason) {
        appendLabeledText(card, "Stop reason", handoff.stopReason);
      }
      if (handoff.commitSha) {
        appendLabeledText(card, "Commit", shortSha(handoff.commitSha));
      }
      const links = createElement(
        "div",
        "agentic-researcher-orchestrator-link-list",
      );
      for (const evidenceId of handoff.evidenceIds) {
        links.appendChild(
          actionButton(evidenceId, () =>
            this.navigate({
              kind: "evidence",
              id: evidenceId,
              nodeId: handoff.taskId || undefined,
            }),
            `handoff-evidence:${handoff.id}:${evidenceId}`,
          ),
        );
      }
      if (links.childElementCount > 0) {
        card.appendChild(links);
      }
      list.appendChild(card);
    }
    if (compactedCount > 0) {
      section.appendChild(compactedMarker(compactedCount, "handoffs"));
    }
  }

  private renderMerge(root: HTMLElement, viewModel: OrchestratorViewModel) {
    const section = createSection(root, "merge", "Merge and verification");
    const merge = viewModel.merge;
    const header = section.querySelector<HTMLElement>(
      ".agentic-researcher-orchestrator-section-header",
    );
    header?.appendChild(statusBadge(merge.status));
    const metrics = createElement(
      "div",
      "agentic-researcher-orchestrator-merge-grid",
    );
    section.appendChild(metrics);
    const values: Array<[string, number | string]> = [
      ["Received", merge.received],
      ["Accepted", merge.accepted],
      ["Rejected", merge.rejected],
      ["Deduplicated", merge.deduplicated],
      ["Conflicts", merge.conflicts],
      ["Code commits", merge.codeCommits],
      ["Verification", merge.verification || "Pending"],
      ["Integration", merge.integration || "Not applicable"],
    ];
    for (const [label, value] of values) {
      const item = createElement(
        "div",
        "agentic-researcher-orchestrator-merge-item",
      );
      appendText(item, "span", label, "agentic-researcher-orchestrator-kicker");
      appendText(item, "strong", String(value));
      metrics.appendChild(item);
    }
    if (merge.blocker) {
      const blocker = appendLabeledText(section, "Blocker", merge.blocker);
      blocker.classList.add("is-error");
    }
    section.appendChild(
      actionButton(
        "View verification details",
        () => this.navigate({ kind: "verification", id: "orchestrator" }),
        "merge-verification",
      ),
    );
  }

  private renderSourceLedger(root: HTMLElement, viewModel: OrchestratorViewModel) {
    const ledger = viewModel.sourceLedger;
    if (!ledger) {
      return;
    }
    const section = createSection(root, "sources", "Sources & proof debt");
    const metrics = createElement(
      "div",
      "agentic-researcher-orchestrator-merge-grid",
    );
    section.appendChild(metrics);
    for (const [label, value] of [
      ["Candidates", ledger.candidateCount],
      ["Usable", ledger.usableCount],
      ["Unusable", ledger.unusableCount],
      ["Rejected", ledger.rejectedCount],
      ["Proof debt", ledger.proofDebtMissing],
    ] as Array<[string, number]>) {
      const item = createElement(
        "div",
        "agentic-researcher-orchestrator-merge-item",
      );
      appendText(item, "span", label, "agentic-researcher-orchestrator-kicker");
      appendText(item, "strong", String(value));
      metrics.appendChild(item);
    }
    for (const line of ledger.topSourceLines) {
      appendLabeledText(section, "Source", line);
    }
    for (const line of ledger.proofDebtLines) {
      const row = appendLabeledText(section, "Debt", line);
      row.classList.add("is-error");
    }
  }

  private navigate(target: OrchestratorDetailsTarget) {
    this.options.onNavigateToRunDetails?.(target);
  }
}

function createSection(
  root: HTMLElement,
  name: string,
  title: string,
): HTMLElement {
  const section = createElement(
    "section",
    "agentic-researcher-orchestrator-section",
  );
  section.dataset.orchestratorSection = name;
  const header = createElement(
    "div",
    "agentic-researcher-orchestrator-section-header",
  );
  appendText(
    header,
    "h3",
    title,
    "agentic-researcher-orchestrator-section-title",
  );
  section.appendChild(header);
  root.appendChild(section);
  return section;
}

function appendLabeledText(
  parent: HTMLElement,
  label: string,
  value: string,
): HTMLElement {
  const row = createElement("div", "agentic-researcher-orchestrator-detail");
  appendText(row, "span", `${label}: `, "agentic-researcher-orchestrator-kicker");
  appendText(row, "span", value);
  parent.appendChild(row);
  return row;
}

function actionButton(
  label: string,
  onClick: () => void,
  focusKey?: string,
): HTMLButtonElement {
  const button = createElement(
    "button",
    "agentic-researcher-orchestrator-link",
  ) as HTMLButtonElement;
  button.type = "button";
  button.textContent = label;
  if (focusKey) {
    button.dataset.orchestratorFocusKey = focusKey;
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function statusBadge(status: string): HTMLElement {
  const badge = textBadge(status.replace(/_/g, " "));
  badge.classList.add("agentic-researcher-orchestrator-status");
  badge.dataset.status = status;
  return badge;
}

function textBadge(text: string, extraClass?: string): HTMLElement {
  const badge = createElement(
    "span",
    "agentic-researcher-orchestrator-badge",
  );
  if (extraClass) {
    badge.classList.add(extraClass);
  }
  badge.textContent = text.toUpperCase();
  return badge;
}

function placeholder(text: string): HTMLElement {
  const element = createElement(
    "div",
    "agentic-researcher-placeholder agentic-researcher-orchestrator-placeholder",
  );
  element.textContent = text;
  return element;
}

function compactedMarker(count: number, label: string): HTMLElement {
  const marker = createElement(
    "div",
    "agentic-researcher-compacted agentic-researcher-orchestrator-compacted",
  );
  marker.textContent = `${count} ${label} compacted.`;
  return marker;
}

function appendText<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const child = document.createElement(tag);
  if (className) {
    child.className = className;
  }
  child.textContent = text;
  parent.appendChild(child);
  return child;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  return element;
}

function shortSha(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}
