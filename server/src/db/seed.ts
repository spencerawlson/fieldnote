/**
 * Seeds a demonstration project.
 *
 *     npm run seed
 *
 * Creates an account and a worked example — the Active Directory lab from the
 * documentation — so a fresh install has something real to look at. Uses only
 * the same repository functions the API uses, so what you see is what the
 * product produces, not a hand-built fixture.
 *
 * Idempotent: running it twice reuses the account and adds a second project.
 * It never touches an existing project.
 */

import { getDb, closeDb } from './index.ts';
import { createUser, getUserByEmail } from './repositories/system.ts';
import { createProject } from './repositories/projects.ts';
import { createStep, createCommand } from './repositories/steps.ts';
import { createProblem, createInvestigation, createResolution, createTest, createResult } from './repositories/knowledge.ts';
import { indexProject } from '../search/indexer.ts';
import { hashPassword } from '../lib/core.ts';
import { logger } from '../lib/logger.ts';
import { config } from '../config.ts';

const EMAIL = process.env.SEED_EMAIL ?? 'demo@fieldnote.local';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password-change-me';

interface SeedStep {
  title: string;
  description: string;
  category: string;
  status?: 'done' | 'failed';
  command?: { language: string; content: string };
  configuration?: string;
}

const STEPS: SeedStep[] = [
  {
    title: 'Installed Windows Server 2022',
    description: 'Installed Windows Server 2022 Standard (Desktop Experience) on the lab hypervisor.',
    category: 'installation',
  },
  {
    title: 'Configured a static IP address',
    description: 'Set the server to 10.20.20.10/24 with no default gateway, since the lab has no upstream router.',
    category: 'networking',
    configuration: 'IPv4 10.20.20.10/24, DNS 127.0.0.1',
  },
  {
    title: 'Installed the AD DS role',
    description: 'Added the Active Directory Domain Services role through Server Manager.',
    category: 'installation',
    command: { language: 'powershell', content: 'Install-WindowsFeature AD-Domain-Services -IncludeManagementTools' },
  },
  {
    title: 'Promoted the server to a domain controller',
    description: 'Created a new forest, lab.local, with the default functional level.',
    category: 'configuration',
    command: {
      language: 'powershell',
      content: 'Install-ADDSForest -DomainName lab.local -InstallDns -DomainNetbiosName LAB',
    },
  },
  {
    title: 'Created user accounts',
    description: 'Created two standard accounts in the Users container for testing domain sign-in.',
    category: 'configuration',
  },
  {
    title: 'Attempted to join the Windows 11 client',
    description: 'Tried to join WIN11-CLIENT to lab.local. The join failed.',
    category: 'troubleshooting',
    status: 'failed',
  },
  {
    title: 'Changed the client DNS server',
    description: 'Set the client\'s DNS server to 10.20.20.10, the domain controller, instead of the router.',
    category: 'networking',
    command: {
      language: 'powershell',
      content: 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses 10.20.20.10',
    },
  },
  {
    title: 'Retried the domain join',
    description: 'Retried the join with the corrected DNS setting. The client joined and restarted into the domain.',
    category: 'validation',
  },
];

function seed(): void {
  const db = getDb();

  const user = getUserByEmail(db, EMAIL) ?? createUser(db, {
    email: EMAIL,
    name: 'Demo Author',
    passwordHash: hashPassword(PASSWORD),
  });

  const project = createProject(db, {
    ownerId: user.id,
    title: 'Active Directory Lab',
    summary: 'Standing up a Windows domain and joining a client to it.',
    objective: 'Build a single-domain Active Directory forest and demonstrate a successful domain join.',
    domain: 'windows-server',
    tone: 'academic',
    audience: 'professor',
    elaborationDepth: 3,
  });

  const stepIds: string[] = [];
  for (const [index, seedStep] of STEPS.entries()) {
    const step = createStep(db, {
      projectId: project.id,
      title: seedStep.title,
      userDescription: seedStep.description,
      category: seedStep.category,
      status: seedStep.status ?? 'done',
      configuration: seedStep.configuration ?? null,
      position: index + 1,
    });
    stepIds.push(step.id);
    if (seedStep.command) {
      createCommand(db, { projectId: project.id, stepId: step.id, ...seedStep.command });
    }
  }

  const problem = createProblem(db, {
    projectId: project.id,
    stepId: stepIds[5],
    title: 'Domain join failed',
    symptoms:
      'An Active Directory Domain Controller for the domain lab.local could not be contacted. Ensure that the domain name is typed correctly.',
    status: 'resolved',
  });

  createInvestigation(db, {
    problemId: problem.id,
    action: 'Checked the client\'s DNS configuration',
    finding: 'The client was still pointing at the lab router, which holds no record of lab.local.',
    tool: 'ipconfig /all',
  });
  createInvestigation(db, {
    problemId: problem.id,
    action: 'Queried the domain controller SRV record',
    finding: 'The query failed against the router and succeeded against 10.20.20.10.',
    tool: 'nslookup -type=SRV _ldap._tcp.dc._msdcs.lab.local',
  });

  createResolution(db, {
    problemId: problem.id,
    description: 'Pointed the client at the domain controller for DNS.',
    validation: 'The domain join was retried and completed successfully.',
    // Deliberately false: this project holds no screenshot proving it, and the
    // product should say so rather than assert a validated fix.
    validated: false,
  });

  createTest(db, {
    projectId: project.id,
    name: 'Domain join',
    method: 'System Properties → Change → Member of domain: lab.local',
    expected: 'The client joins and prompts for a restart',
    observed: 'Joined successfully; restarted into the domain',
    outcome: 'pass',
  });

  createResult(db, {
    projectId: project.id,
    title: 'A single-domain forest, lab.local, with one joined Windows 11 client',
    detail: 'The domain controller runs AD DS and DNS; the client authenticates against it.',
  });

  indexProject(db, project.id);

  logger.info(
    { projectId: project.id, steps: stepIds.length, email: EMAIL, database: config.db.path },
    'Seeded a demonstration project',
  );
  process.stdout.write(
    `\nSeeded "Active Directory Lab".\n` +
      `  Sign in as: ${EMAIL}\n` +
      `  Password:   ${PASSWORD}\n\n` +
      `Nothing has been analysed yet — open the project and press "Analyse project"\n` +
      `to watch the pipeline run.\n\n`,
  );
}

seed();
closeDb();
