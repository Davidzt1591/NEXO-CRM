const enableBackendWatch = process.env.PM2_WATCH_BACKEND === 'true';
const nodeInterpreter = process.env.NEXO_NODE22 || process.execPath;

module.exports = {
  apps: [
    {
      name: 'nexo-backend',
      script: 'server.js',
      cwd: './backend',
      interpreter: nodeInterpreter,
      node_args: ['--use-system-ca'],
      instances: 1,
      autorestart: true,
      watch: enableBackendWatch ? ['server.js', 'src', 'scripts'] : false,
      ignore_watch: [
        'node_modules',
        'logs',
        'data',
        '.wwebjs_auth',
        '.wwebjs_cache',
        'backend-runtime.err.log',
        'backend-runtime.out.log',
        'pairing_err.txt',
        'pairing_error.log',
        'test',
      ],
      watch_delay: 1000,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
        PM2_WATCH_BACKEND: 'false',
        PM2_USE_SYSTEM_CA: 'true',
      },
      env_development: {
        NODE_ENV: 'development',
        PM2_WATCH_BACKEND: 'true',
        PM2_USE_SYSTEM_CA: 'true',
      },
      env_production: {
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'http://localhost:5173',
        HOST: '127.0.0.1',
        ALLOW_INSECURE_LOCAL_COOKIE: 'true',
        SESSION_COOKIE_SECURE: 'false',
        TRUST_PROXY_CIDRS: '',
        PM2_WATCH_BACKEND: 'false',
        PM2_USE_SYSTEM_CA: 'true',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'nexo-frontend',
      script: 'serve-frontend.js',
      cwd: './',
      interpreter: nodeInterpreter,
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
      env_production: {
        NODE_ENV: 'production',
      },
    }
  ]
};
