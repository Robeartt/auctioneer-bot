import { APP_CONFIG } from './config.js';
import { logger } from './logger.js';

async function sendSlackNotification(message: string): Promise<void> {
  try {
    if (APP_CONFIG.slackWebhook) {
      const response = await fetch(APP_CONFIG.slackWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: `*Bot Name*: ${APP_CONFIG.name}\n${message}`,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    }
  } catch (e) {
    logger.error(`Error sending Slack notification: ${e}`);
  }
}

async function sendDiscordNotification(message: string): Promise<void> {
  try {
    if (APP_CONFIG.discordWebhook) {
      const response = await fetch(APP_CONFIG.discordWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: `**${APP_CONFIG.name}**\n${message}`,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    }
  } catch (e) {
    logger.error(`Error sending Discord notification: ${e}`);
  }
}

export async function sendNotification(message: string): Promise<void> {
  // If no webhooks are configured, log to console as fallback
  if (!APP_CONFIG.slackWebhook && !APP_CONFIG.discordWebhook) {
    console.log(
      `Bot Name: ${APP_CONFIG.name}\nTimestamp: ${new Date().toISOString()}\n${message}`
    );
    return;
  }

  // Send to both platforms in parallel if configured
  const notifications = [];

  if (APP_CONFIG.slackWebhook) {
    notifications.push(sendSlackNotification(message));
  }

  if (APP_CONFIG.discordWebhook) {
    notifications.push(sendDiscordNotification(message));
  }

  try {
    await Promise.all(notifications);
  } catch (error) {
    logger.error(`Error sending notifications: ${error}`);
  }
}