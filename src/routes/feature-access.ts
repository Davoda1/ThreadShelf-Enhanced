import type { Request, RequestHandler } from 'express';
import { isLoopbackHttpRequest } from './loopback.js';

type ManagedFeature = 'ai' | 'tts';
const flagFor = (feature: ManagedFeature): string =>
  feature === 'ai' ? 'ALLOW_LAN_AI' : 'ALLOW_LAN_TTS';

/** Explicit trusted-network administration. These flags are permissions, not
 * authentication or a subnet filter: the main server's Host/Origin guards and
 * deployment network boundary still apply. They never affect /v1 access. */
export const isFeatureManagementRequest = (req: Request, feature: ManagedFeature): boolean =>
  isLoopbackHttpRequest(req) || process.env[flagFor(feature)]?.trim() === '1';

const requireFeatureManagement =
  (feature: ManagedFeature): RequestHandler =>
  (req, res, next) => {
    if (!isFeatureManagementRequest(req, feature)) {
      res.status(403).json({
        error: `These controls require localhost or ${flagFor(feature)}=1 in the server .env (restart required).`,
      });
      return;
    }
    next();
  };

export const requireAiManagement = requireFeatureManagement('ai');
export const requireTtsManagement = requireFeatureManagement('tts');
