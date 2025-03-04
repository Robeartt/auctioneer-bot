import { APP_CONFIG } from './config.js';
import { logger } from './logger.js';

export async function sendSlackNotification(poolAddress: string, message: string): Promise<void> {
  try {
    if (APP_CONFIG.slackWebhook) {
      const response = await fetch(APP_CONFIG.slackWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: `*Bot Name*: ${APP_CONFIG.name}\n*Pool Address*: ${poolAddress}\n${message}`,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    } else {
      console.log(
        `Bot Name: ${APP_CONFIG.name}\nTimestamp: ${new Date().toISOString()}\nPool Address: ${poolAddress}\n${message}`
      );
    }
  } catch (e) {
    logger.error(`Error sending slack notification: ${e}`);
  }
}
