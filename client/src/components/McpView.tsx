import { t, useI18n } from '../i18n';
import { useState, useCallback } from 'react';
import { Icons } from '../icons';
import { copyText } from '../utils';

const MCP_COMMAND = 'npm run mcp';

const MCP_CONFIG = `{
  "mcpServers": {
    "threadshelf": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/path/to/threadshelf"
    }
  }
}`;

export function McpView() {
  useI18n();
  const [copied, setCopied] = useState('');

  const copy = useCallback((key: string, text: string) => {
    void copyText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 1400);
  }, []);

  return (
    <div className="view">
      <div className="section-h">
        <h2>{t('MCP server')}</h2>
        <span className="desc">
          {t(
            'Expose your local archive to Claude Desktop, Cursor, and other MCP clients over stdio.',
          )}
        </span>
      </div>

      <div className="banner info">
        <span className="ico">{Icons.info}</span>
        <div className="grow">
          {t(
            'MCP runs over stdio against your local LanceDB — no port, no auth surface. Stop the process to revoke access.',
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>{t('Start the server')}</h3>
          <span className="sub">{t('run from project root')}</span>
        </div>
        <div className="panel-body">
          <pre
            style={{
              position: 'relative',
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              background: 'var(--bg-2)',
              padding: '12px 14px',
              borderRadius: 'var(--r-sm)',
              color: 'var(--text-0)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {MCP_COMMAND}
            <button
              className="btn sm ghost"
              style={{ position: 'absolute', top: 6, right: 6 }}
              onClick={() => copy('cmd', MCP_COMMAND)}
            >
              {t(copied === 'cmd' ? 'copied' : 'copy')}
            </button>
          </pre>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>{t('Claude Desktop config')}</h3>
          <span className="sub">{t('Settings → MCP → Edit config')}</span>
        </div>
        <div className="panel-body">
          <pre
            style={{
              position: 'relative',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              background: 'var(--bg-2)',
              padding: '12px 14px',
              borderRadius: 'var(--r-sm)',
              color: 'var(--text-0)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {MCP_CONFIG}
            <button
              className="btn sm ghost"
              style={{ position: 'absolute', top: 6, right: 6 }}
              onClick={() => copy('cfg', MCP_CONFIG)}
            >
              {t(copied === 'cfg' ? 'copied' : 'copy')}
            </button>
          </pre>
        </div>
      </div>
    </div>
  );
}
