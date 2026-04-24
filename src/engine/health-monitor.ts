export type HealthMonitorOptions = {
  heartbeatIntervalSeconds: number;
  stallBeatsThreshold: number;
  capturePane: (agent: string, lines: number) => string;
  getActiveAgents: () => string[];
  onStall: (agent: string, paneContent: string) => void;
  onWorking: (agent: string) => void;
  logHealthEvent: (agent: string, event: string, detail: string) => void;
};

type AgentSnapshot = {
  lastCapture: string;
  stillBeats: number;
  stallNotified: boolean;
};

export class HealthMonitor {
  private options: HealthMonitorOptions;
  private snapshots = new Map<string, AgentSnapshot>();
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(options: HealthMonitorOptions) {
    this.options = options;
  }

  getStallCount(agent: string): number {
    return this.snapshots.get(agent)?.stillBeats ?? 0;
  }

  startHeartbeat() {
    this.intervalId = setInterval(() => {
      this.beat();
    }, this.options.heartbeatIntervalSeconds * 1000);
  }

  stopHeartbeat() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  resetAgent(agent: string) {
    this.snapshots.delete(agent);
  }

  private beat() {
    const activeAgents = this.options.getActiveAgents();

    for (const agent of activeAgents) {
      const capture = this.options.capturePane(agent, 40);
      if (!capture.trim()) continue;

      const snapshot = this.snapshots.get(agent);

      if (!snapshot) {
        this.snapshots.set(agent, { lastCapture: capture, stillBeats: 0, stallNotified: false });
        continue;
      }

      if (capture === snapshot.lastCapture) {
        snapshot.stillBeats++;

        if (snapshot.stillBeats >= this.options.stallBeatsThreshold && !snapshot.stallNotified) {
          snapshot.stallNotified = true;
          const seconds = snapshot.stillBeats * this.options.heartbeatIntervalSeconds;
          this.options.logHealthEvent(agent, "stall_detected", `Pane unchanged for ${seconds}s`);
          this.options.onStall(agent, capture);
        }
      } else {
        snapshot.lastCapture = capture;
        snapshot.stillBeats = 0;
        snapshot.stallNotified = false;
        this.options.onWorking(agent);
      }
    }

    // Clean up agents that are no longer active
    for (const agent of this.snapshots.keys()) {
      if (!activeAgents.includes(agent)) {
        this.snapshots.delete(agent);
      }
    }
  }
}
