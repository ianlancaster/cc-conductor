import { createServer, type Server } from "http";
import { log } from "../logger.js";

export type McpToolHandler = (args: Record<string, unknown>, caller: string) => Promise<string>;

export type McpServerConfig = {
  port: number;
  tools: Record<string, { description: string; inputSchema: Record<string, unknown>; handler: McpToolHandler }>;
};

export class ConductorMcpServer {
  private server: Server;
  private tools: McpServerConfig["tools"];
  private port: number;
  onCommand: ((input: string) => Promise<string>) | null;

  constructor(config: McpServerConfig) {
    this.tools = config.tools;
    this.port = config.port;

    this.onCommand = null;

    this.server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/mcp/")) {
        const caller = decodeURIComponent(req.url.slice("/mcp/".length));
        await this.handleMcpRequest(req, res, caller);
      } else if (req.method === "POST" && req.url === "/mcp") {
        await this.handleMcpRequest(req, res, "unknown");
      } else if (req.method === "POST" && req.url === "/cmd") {
        await this.handleCmdRequest(req, res);
      } else if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", tools: Object.keys(this.tools) }));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Permissive timeouts for long-running tools (consult_agent can take
    // minutes as the recipient loads cognitive state + responds). Node's
    // default requestTimeout of 5 min would otherwise cut off long consults
    // server-side. Client-side timeouts (e.g., Claude Code's MCP client)
    // are a separate concern and must be configured independently.
    this.server.headersTimeout = 0;
    this.server.requestTimeout = 0;
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 60_000;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, "127.0.0.1", () => {
        resolve();
      });
    });
  }

  stop(): void {
    this.server.close();
  }

  getPort(): number {
    return this.port;
  }

  private async handleMcpRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    caller: string
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString("utf-8");

    try {
      const request = JSON.parse(body) as {
        jsonrpc: string;
        id: number | string;
        method: string;
        params?: Record<string, unknown>;
      };

      log().debug("mcp", `Request: ${request.method}`, { id: request.id });

      if (request.method === "initialize") {
        log().info("mcp", "Client initializing", { params: request.params });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "agent-conductor", version: "1.0.0" },
            },
          })
        );
        return;
      }

      if (request.method === "notifications/initialized" || request.method?.startsWith("notifications/")) {
        // Notifications don't get responses in JSON-RPC, but HTTP still needs an ACK
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", result: null }));
        return;
      }

      if (request.method === "tools/list") {
        log().debug("mcp", "Listing tools");
        const toolList = Object.entries(this.tools).map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: {
            type: "object",
            properties: def.inputSchema,
          },
        }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { tools: toolList },
          })
        );
        return;
      }

      if (request.method === "tools/call") {
        const params = request.params as { name: string; arguments: Record<string, unknown> };
        log().info("mcp", `Tool call: ${params.name}`, { args: JSON.stringify(params.arguments).slice(0, 200) });
        const tool = this.tools[params.name];

        if (!tool) {
          log().warn("mcp", `Unknown tool: ${params.name}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: `Unknown tool: ${params.name}` },
            })
          );
          return;
        }

        const result = await tool.handler(params.arguments, caller);
        log().info("mcp", `Tool ${params.name} complete (${result.length} chars, caller=${caller})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: result }],
            },
          })
        );
        return;
      }

      // Default: method not found
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        })
      );
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${err}` },
        })
      );
    }
  }

  private async handleCmdRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString("utf-8");

    try {
      const { command } = JSON.parse(body) as { command: string };
      if (!this.onCommand) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "CLI handler not registered" }));
        return;
      }
      const response = await this.onCommand(command);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ response }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }
}
