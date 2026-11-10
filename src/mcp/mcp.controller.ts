import { All, Controller, Logger, Param, Req, Res } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { LocalUserService } from '../user/local-user.service';
import { McpSettingsService } from './mcp-settings.service';
import { McpService } from './mcp.service';

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly mcp: McpService,
    private readonly settings: McpSettingsService,
    private readonly localUser: LocalUserService,
  ) {}

  @All()
  handle(@Req() req: Request, @Res() res: Response) {
    return this.serve(req, res, undefined);
  }

  @All(':key')
  handleWithKey(@Req() req: Request, @Res() res: Response, @Param('key') key: string) {
    return this.serve(req, res, key);
  }

  private async serve(req: Request, res: Response, pathKey?: string) {
    const userId = await this.localUser.id();
    const access = await this.settings.access(userId);
    if (!access.enabled) {
      res.status(403).json({ error: 'The MCP connector is turned off in Settings' });
      return;
    }
    if (!this.authorized(req, access.key, pathKey)) {
      res.status(401).json({ error: 'Invalid or missing MCP key' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' });
      return;
    }
    void this.settings.touch(userId).catch((err) => this.logger.warn(err));

    const server = this.mcp.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      this.logger.error(error);
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  }

  private authorized(req: Request, expected: string | null, pathKey?: string) {
    if (!expected) return true;

    const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const provided = pathKey || header || (typeof req.query.key === 'string' ? req.query.key : '');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
