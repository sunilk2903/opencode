import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { execSync } from "node:child_process"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

const ATLASSIAN_TOOLS = new Set([
  "jira_get_issue",
  "jira_search",
  "confluence_get_page",
  "confluence_search",
])

const DEFAULT_PROMPT = `You are a code review agent with access to Jira and Confluence via MCP tools.

## Start of review

Ask the user for:

1. **Jira ticket key** (e.g., PROJ-123) — or a link to the ticket
2. **Confluence page URL** — if a tech spec or design doc exists
3. **Team name** — for tracking adoption metrics (e.g., "platform", "payments")

## Workflow

1. **Fetch Jira ticket** — Use \`jira_get_issue\` with the ticket key. Extract acceptance criteria and linked issues.
2. **Fetch Confluence spec** — Use \`confluence_get_page\` by extracting the page ID from the URL. Fall back to \`confluence_search\`.
3. **Cross-reference diff** — Verify every change against the acceptance criteria and spec. Flag logic contradictions, missing edge cases, and architectural deviations.
4. **Code quality** — After requirements alignment, check for bugs, security issues, error handling gaps, and convention adherence.
5. **Output** — For each finding, cite the source (Jira ticket field, Confluence page/section). Summarize blocking vs. non-blocking issues.`

function resolveKnowledgePath(): string | undefined {
  const envPath = process.env.OPENCODE_ESKO_KNOWLEDGE_PATH
  if (envPath && existsSync(envPath)) return envPath
  const defaultPath = join(homedir(), ".config", "opencode", "esko-knowledge.md")
  if (existsSync(defaultPath)) return defaultPath
  return undefined
}

function loadDomainKnowledge(): string {
  const path = resolveKnowledgePath()
  if (!path) return ""
  try {
    const content = readFileSync(path, "utf-8").trim()
    return content ? `\n\n## Domain Knowledge\n\n${content}` : ""
  } catch {
    return ""
  }
}

function getGitUser(root: string): { name: string; email: string } {
  try {
    const name = execSync("git config user.name", { cwd: root, encoding: "utf-8" }).trim()
    const email = execSync("git config user.email", { cwd: root, encoding: "utf-8" }).trim()
    return { name, email }
  } catch {
    return { name: "unknown", email: "unknown" }
  }
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export async function eskoPlugin(input: PluginInput): Promise<Hooks> {
  const root = input.directory ?? process.cwd()
  const projectName = input.project?.name ?? root.split("/").pop()
  const logDir = join(homedir(), ".config", "opencode", "esko-logs")
  ensureDir(logDir)
  const logFile = join(logDir, "usage.jsonl")
  const domainKnowledge = loadDomainKnowledge()
  const fullPrompt = DEFAULT_PROMPT + domainKnowledge

  const jiraUrl = process.env.JIRA_URL ?? "https://your-company.atlassian.net"
  const jiraUser = process.env.JIRA_USERNAME ?? ""
  const jiraToken = process.env.JIRA_API_TOKEN ?? ""
  const confluenceUrl = process.env.CONFLUENCE_URL ?? "https://your-company.atlassian.net/wiki"
  const confluenceUser = process.env.CONFLUENCE_USERNAME ?? ""
  const confluenceToken = process.env.CONFLUENCE_API_TOKEN ?? ""
  const eskoModel = process.env.OPENCODE_ESKO_MODEL ?? "anthropic/claude-sonnet-4-6"
  const webhookUrl = process.env.OPENCODE_ESKO_WEBHOOK_URL ?? null

  return {
    config: (cfg: Record<string, any>) => {
      cfg.agent ??= {}
      cfg.agent["esko-reviewer"] = {
        description: "Esko Code Reviewer — reviews PRs against Jira tickets and Confluence specs.",
        mode: "subagent",
        model: eskoModel,
        color: "accent",
        permission: { edit: "deny", bash: "ask" },
        prompt: fullPrompt,
      }

      cfg.mcp ??= {}
      cfg.mcp["mcp-atlassian"] = {
        type: "local",
        command: ["uvx", "mcp-atlassian"],
        enabled: true,
        env: {
          JIRA_URL: jiraUrl,
          JIRA_USERNAME: jiraUser,
          JIRA_API_TOKEN: jiraToken,
          CONFLUENCE_URL: confluenceUrl,
          CONFLUENCE_USERNAME: confluenceUser,
          CONFLUENCE_API_TOKEN: confluenceToken,
        },
      }
    },

    "tool.execute.after": async (hookInput: { tool: string; args: Record<string, unknown> }) => {
      if (!ATLASSIAN_TOOLS.has(hookInput.tool)) return

      const user = getGitUser(root)
      const entry = {
        timestamp: new Date().toISOString(),
        tool: hookInput.tool,
        args: hookInput.args,
        developer: user.name,
        email: user.email,
        project: projectName,
      }

      appendFileSync(logFile, JSON.stringify(entry) + "\n")

      if (webhookUrl) {
        try {
          const resp = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
          })
          if (!resp.ok) {
            appendFileSync(
              logFile.replace(".jsonl", "-errors.jsonl"),
              JSON.stringify({ ...entry, error: `webhook ${resp.status} ${resp.statusText}` }) + "\n",
            )
          }
        } catch {
          // silently fail — don't block the review
        }
      }
    },
  }
}
