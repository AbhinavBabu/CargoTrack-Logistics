import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { swaggerSpec } from './swagger';

// Routes — core domain only
// Documents are handled by document-service (port 4001)
import healthRoutes from './routes/health';
import authRoutes from './routes/auth';
import shipmentRoutes from './routes/shipments';
import trackingRoutes from './routes/tracking';
import notificationRoutes from './routes/notifications';
import reportRoutes from './routes/reports';
import adminRoutes from './routes/admin';
import copilotProxyRoutes from './routes/copilot';

const prisma = new PrismaClient();

/**
 * Creates the admin account on startup if it doesn't exist.
 * Core service owns user management so seeding runs here only.
 */
async function ensureAdminExists(): Promise<void> {
  try {
    const existing = await prisma.user.findUnique({
      where: { email: config.adminEmail },
    });

    if (!existing) {
      const hashed = await bcrypt.hash(config.adminPassword, 10);
      await prisma.user.create({
        data: { email: config.adminEmail, password: hashed, name: 'Admin', role: 'ADMIN' },
      });
      console.log(`[core-service] Admin account created: ${config.adminEmail}`);
    } else if (existing.role !== 'ADMIN') {
      await prisma.user.update({
        where: { email: config.adminEmail },
        data: { role: 'ADMIN' },
      });
      console.log(`[core-service] Admin role updated: ${config.adminEmail}`);
    } else {
      console.log(`[core-service] Admin account exists: ${config.adminEmail}`);
    }
  } catch (err) {
    console.error('[core-service] Failed to seed admin:', err);
  }
}

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

// Swagger docs
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/shipments', shipmentRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);
// Copilot proxy — forwards authenticated requests to ai-service copilot endpoints
app.use('/api/admin/copilot', copilotProxyRoutes);

// Error handler (must be last)
app.use(errorHandler);

async function main() {
  await ensureAdminExists();

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[core-service] Running on port ${config.port} (${config.nodeEnv})`);
    console.log(`[core-service] Swagger: http://localhost:${config.port}/api/docs`);
  });
}

main().catch((err) => {
  console.error('[core-service] Startup failed:', err);
  process.exit(1);
});

export default app;
