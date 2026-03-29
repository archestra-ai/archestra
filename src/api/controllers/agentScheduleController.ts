import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { validateCronExpression, calculateNextRun, isValidTimezone } from '../../validators/scheduleValidator';

const prisma = new PrismaClient();

export const createSchedule = async (req: Request, res: Response) => {
  try {
    const { id: agentId } = req.params;
    const { cronExpression, timezone = 'UTC', isActive = true } = req.body;

    if (!validateCronExpression(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression.' });
    }

    if (!isValidTimezone(timezone)) {
      return res.status(400).json({ error: 'Invalid timezone.' });
    }

    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found.' });
    }

    const nextRunAt = calculateNextRun(cronExpression, timezone);

    const schedule = await prisma.agentScheduleTrigger.create({
      data: {
        agentId,
        cronExpression,
        timezone,
        isActive,
        nextRunAt,
      },
    });

    return res.status(201).json(schedule);
  } catch (error) {
    console.error('Error creating schedule:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};

export const updateSchedule = async (req: Request, res: Response) => {
  try {
    const { id: agentId, scheduleId } = req.params;
    const { cronExpression, timezone, isActive } = req.body;

    const existingSchedule = await prisma.agentScheduleTrigger.findFirst({
      where: { id: scheduleId, agentId },
    });

    if (!existingSchedule) {
      return res.status(404).json({ error: 'Schedule not found.' });
    }

    const dataToUpdate: any = { isActive };

    if (cronExpression !== undefined) {
      if (!validateCronExpression(cronExpression)) {
        return res.status(400).json({ error: 'Invalid cron expression.' });
      }
      dataToUpdate.cronExpression = cronExpression;
    }

    if (timezone !== undefined) {
      if (!isValidTimezone(timezone)) {
        return res.status(400).json({ error: 'Invalid timezone.' });
      }
      dataToUpdate.timezone = timezone;
    }

    if (cronExpression !== undefined || timezone !== undefined || (isActive && !existingSchedule.isActive)) {
      const nextCron = cronExpression ?? existingSchedule.cronExpression;
      const nextTz = timezone ?? existingSchedule.timezone;
      dataToUpdate.nextRunAt = calculateNextRun(nextCron, nextTz);
    }

    const updatedSchedule = await prisma.agentScheduleTrigger.update({
      where: { id: scheduleId },
      data: dataToUpdate,
    });

    return res.status(200).json(updatedSchedule);
  } catch (error) {
    console.error('Error updating schedule:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};

export const getSchedules = async (req: Request, res: Response) => {
  try {
    const { id: agentId } = req.params;
    const schedules = await prisma.agentScheduleTrigger.findMany({
      where: { agentId },
      orderBy: { createdAt: 'desc' }
    });

    return res.status(200).json(schedules);
  } catch (error) {
    console.error('Error fetching schedules:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};

export const deleteSchedule = async (req: Request, res: Response) => {
  try {
    const { id: agentId, scheduleId } = req.params;

    const existingSchedule = await prisma.agentScheduleTrigger.findFirst({
      where: { id: scheduleId, agentId },
    });

    if (!existingSchedule) {
      return res.status(404).json({ error: 'Schedule not found.' });
    }

    await prisma.agentScheduleTrigger.delete({
      where: { id: scheduleId },
    });

    return res.status(204).send();
  } catch (error) {
    console.error('Error deleting schedule:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};