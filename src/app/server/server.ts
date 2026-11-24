import { createApp, genie, lakebase, server } from '@databricks/appkit';
import { registerCampaignRoutes } from './routes/ops/campaign-routes';
import { registerContractUploadRoutes, removeAllUploads } from './routes/ops/contract-upload-routes';
import { registerInsightRoutes } from './routes/ops/insight-routes';
import { registerMakeGoodRoutes } from './routes/ops/make-good-routes';
import { type AppKitWithLakebase, fail, resetOps, setAppSeed, setupOpsSchema, userEmail } from './routes/ops/ops-db';
import { clearWarehouseCache, readDemoConfig } from './routes/ops/warehouse';

// Retail Media Hub
// Reads governed data from Unity Catalog through the SQL warehouse and writes operational
// actions to Lakebase (app_ops). The Genie space is created by the setup job; its id is read
// from cfg_demo_config at startup, so run the setup job before starting the app.
const demo = await readDemoConfig();
setAppSeed(demo.appSeed);
// AppKit's genie plugin validates this env var even when spaces are passed in config.
if (demo.genieSpaceId) process.env.DATABRICKS_GENIE_SPACE_ID = demo.genieSpaceId;
const allowReset = (process.env.RMCC_ALLOW_RESET ?? 'true').toLowerCase() === 'true';

createApp({
  plugins: [
    lakebase(),
    server(),
    ...(demo.genieSpaceId ? [genie({ spaces: { default: demo.genieSpaceId } })] : []),
  ],
  async onPluginsReady(appkit) {
    const ak: AppKitWithLakebase = appkit;
    await setupOpsSchema(ak);
    registerInsightRoutes(ak); // before campaign routes: /api/campaigns/sparklines must not hit /api/campaigns/:id
    registerCampaignRoutes(ak);
    registerMakeGoodRoutes(ak);
    registerContractUploadRoutes(ak, demo.extractSpec);
    ak.server.extend((app) => {
      app.get('/api/config', (_req, res) => {
        res.json({ asOfDate: demo.asOfDate, genieEnabled: Boolean(demo.genieSpaceId), resetEnabled: allowReset, retailerName: demo.retailerName,
          contractUpload: Boolean(demo.extractSpec), sampleIoCampaigns: Object.keys(demo.extractSpec?.samples ?? {}).map(Number) });
      });
      app.post('/api/admin/reset-demo', async (req, res) => {
        if (!allowReset) {
          res.status(403).json({ error: 'Reset is disabled (RMCC_ALLOW_RESET=false)' });
          return;
        }
        try {
          await resetOps(ak);
          const removed = demo.extractSpec ? await removeAllUploads() : 0;
          clearWarehouseCache();
          console.log(`[ops] demo data reset by ${userEmail(req)}; removed ${removed} uploaded IO(s)`);
          res.json({ ok: true });
        } catch (err) {
          fail(res, 'Reset demo data', err);
        }
      });
    });
  },
}).catch(console.error);
