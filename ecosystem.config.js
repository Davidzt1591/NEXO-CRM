module.exports = {
  apps: [
    {
      name: 'nexo-backend',
      script: 'server.js',
      cwd: './backend',
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development'
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
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
    }
  ]
};
