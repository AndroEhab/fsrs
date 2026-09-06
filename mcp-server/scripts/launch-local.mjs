/**
 * Launch the compiled MCP server with local-development defaults.
 *
 * The environment file is loaded by Node before this module runs. The server
 * entry point is imported only after transport-specific overrides are set.
 */

const transport = process.argv[2];

if (transport === 'stdio') {
  process.env.MCP_TRANSPORT = 'stdio';
} else if (transport === 'http') {
  const port = process.env.MCP_PORT || process.env.PORT || '8787';
  process.env.MCP_TRANSPORT = 'http';
  process.env.MCP_HOST = '127.0.0.1';
  process.env.MCP_RESOURCE_URL = `http://127.0.0.1:${port}/mcp`;
  process.env.AUTH0_ISSUER = '';
  process.env.AUTH0_AUDIENCE = '';
  process.env.MCP_AUTH_TOKEN = '';
  // The launch-local HTTP server talks to the deployed (remote) backend, but
  // binds to loopback only - that is the desktop-connector/tunnel use case.
  // The remote-auth guard needs this explicit opt-out to stay enabled
  // (authOptOut also disables the startup warning).
  process.env.MCP_AUTH_OPT_OUT = 'true';
} else {
  console.error('Usage: node scripts/launch-local.mjs <stdio|http>');
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  await import('../dist/index.js');
}
