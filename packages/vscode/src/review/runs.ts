import * as vscode from 'vscode';

/**
 * One review, from the command that starts it to its end. It stays current until a
 * newer run starts; only the current run may write findings, snapshots or errors.
 */
export class ReviewRun {
  private readonly cts = new vscode.CancellationTokenSource();

  constructor(
    private readonly owner: ReviewRuns,
    /** Increases with every run; the findings the run shows carry it (`ReviewSession`). */
    readonly generation: number,
  ) {}

  /** Cancelled by Cancel Review, or when a newer run starts. */
  get token(): vscode.CancellationToken {
    return this.cts.token;
  }

  /** No newer run has started. A cancelled run stays current: it may show what it finished. */
  get isCurrent(): boolean {
    return this.owner.isCurrent(this);
  }

  /** For `ReviewRuns` only. */
  cancel(): void {
    this.cts.cancel();
  }

  /** For `ReviewRuns` only. */
  dispose(): void {
    this.cts.dispose();
  }
}

/** Starts review runs and knows which one is current and whether it is still running. */
export class ReviewRuns implements vscode.Disposable {
  private latest = 0;
  private active: ReviewRun | undefined;
  private readonly emitter = new vscode.EventEmitter<boolean>();
  /** Fires `true` when a review starts and `false` when no review is running any more. */
  readonly onDidChange = this.emitter.event;

  get running(): boolean {
    return !!this.active;
  }

  /** The latest run's generation (0 before the first run). */
  get generation(): number {
    return this.latest;
  }

  /** Starts a run. The running one, if any, is cancelled and may no longer write. */
  start(): ReviewRun {
    this.active?.cancel();
    const run = new ReviewRun(this, ++this.latest);
    this.setActive(run);
    return run;
  }

  isCurrent(run: ReviewRun): boolean {
    return run.generation === this.latest;
  }

  /** Cancels the running review, if any. Findings from finished parts are kept. */
  cancel(): void {
    this.active?.cancel();
  }

  /** Ends a run. Ending a superseded run leaves the newer one running. */
  finish(run: ReviewRun): void {
    if (this.active === run) this.setActive(undefined);
    run.dispose();
  }

  private setActive(run: ReviewRun | undefined): void {
    this.active = run;
    this.emitter.fire(!!run);
    void vscode.commands.executeCommand('setContext', 'aiReview.running', !!run);
  }

  dispose(): void {
    this.active?.cancel();
    this.emitter.dispose();
  }
}
