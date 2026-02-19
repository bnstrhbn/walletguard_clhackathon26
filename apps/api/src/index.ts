import 'dotenv/config';

import express, { type Request, type Response } from 'express';
import cors from 'cors';

import { walletguardRouter } from './routes/walletguard.js';
import { intentRouter } from './routes/intent.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.use('/walletguard', walletguardRouter);
app.use('/intent', intentRouter);

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
