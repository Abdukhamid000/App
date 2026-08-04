import {canIOUBePaid} from '@libs/actions/IOU/ReportWorkflow';
import {getSecondaryReportActions} from '@libs/ReportSecondaryActionUtils';

import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import type {Policy, Report, ReportAction, Transaction} from '@src/types/onyx';

/**
 * Repro harness for https://github.com/Expensify/App/issues/97577
 *
 * For each workspace configuration it answers the two questions the issue is about:
 *   "Mark as paid"   -> canIOUBePaid() on the report in its pre-payment state
 *   "Cancel payment" -> getSecondaryReportActions() on the same report once it is APPROVED/REIMBURSED
 *                       with a real `paymentType: ELSEWHERE` pay action recorded against it
 *
 * Nothing here is mocked: the real PolicyUtils/ReportUtils/ReportSecondaryActionUtils run, so the
 * table this prints is what the predicates actually return.
 */
import Onyx from 'react-native-onyx';

import createMock from '../utils/createMock';

const OWNER_EMAIL = 'owner@mail.com';
const OWNER_ACCOUNT_ID = 10;
/** The person doing the test: a workspace admin who is *not* the workspace owner. */
const ACTOR_EMAIL = 'admin2@mail.com';
const ACTOR_ACCOUNT_ID = 11;
const SUBMITTER_EMAIL = 'employee@mail.com';
const SUBMITTER_ACCOUNT_ID = 12;

const REPORT_ID = '97577';
const CHAT_REPORT_ID = '97577chat';
const POLICY_ID = 'POLICY_97577';
const TRANSACTION_ID = 'TRANSACTION_97577';
const PAY_ACTION_ID = 'PAY_ACTION_97577';

type MatrixRow = {
    label: string;
    policy: Policy;
    /** Overrides applied to the pre-payment report for configs that are paid from a different state. */
    prePaymentState?: Pick<Report, 'stateNum' | 'statusNum'>;
};

const chatReport = createMock<Report>({
    reportID: CHAT_REPORT_ID,
    type: CONST.REPORT.TYPE.CHAT,
    chatType: CONST.REPORT.CHAT_TYPE.POLICY_EXPENSE_CHAT,
    policyID: POLICY_ID,
    ownerAccountID: SUBMITTER_ACCOUNT_ID,
});

const transaction = createMock<Transaction>({
    transactionID: TRANSACTION_ID,
    reportID: REPORT_ID,
    amount: -1000,
    currency: 'USD',
    reimbursable: true,
});

/** The report before anyone paid it: approved, still owed. */
function buildPrePaymentReport(overrides?: Pick<Report, 'stateNum' | 'statusNum'>): Report {
    return createMock<Report>({
        reportID: REPORT_ID,
        type: CONST.REPORT.TYPE.EXPENSE,
        policyID: POLICY_ID,
        chatReportID: CHAT_REPORT_ID,
        ownerAccountID: SUBMITTER_ACCOUNT_ID,
        managerID: OWNER_ACCOUNT_ID,
        currency: 'USD',
        total: -1000,
        nonReimbursableTotal: 0,
        stateNum: overrides?.stateNum ?? CONST.REPORT.STATE_NUM.APPROVED,
        statusNum: overrides?.statusNum ?? CONST.REPORT.STATUS_NUM.APPROVED,
    });
}

/** The same report after being marked as paid elsewhere. */
function buildPaidReport(): Report {
    return createMock<Report>({
        ...buildPrePaymentReport(),
        stateNum: CONST.REPORT.STATE_NUM.APPROVED,
        statusNum: CONST.REPORT.STATUS_NUM.REIMBURSED,
    });
}

/** A genuine "marked as paid elsewhere" action, so isPaidViaBankAccount is exercised for real. */
const payElsewhereAction = createMock<ReportAction>({
    reportActionID: PAY_ACTION_ID,
    actionName: CONST.REPORT.ACTIONS.TYPE.IOU,
    actorAccountID: ACTOR_ACCOUNT_ID,
    created: new Date().toISOString(),
    message: {
        IOUTransactionID: TRANSACTION_ID,
        type: CONST.IOU.REPORT_ACTION_TYPE.PAY,
        paymentType: CONST.IOU.PAYMENT_TYPE.ELSEWHERE,
        IOUReportID: REPORT_ID,
        amount: 1000,
        currency: 'USD',
    },
});

function buildPolicy(overrides: Partial<Policy>): Policy {
    return createMock<Policy>({
        id: POLICY_ID,
        name: 'Test workspace',
        type: CONST.POLICY.TYPE.TEAM,
        role: CONST.POLICY.ROLE.ADMIN,
        owner: OWNER_EMAIL,
        ownerAccountID: OWNER_ACCOUNT_ID,
        approvalMode: CONST.POLICY.APPROVAL_MODE.BASIC,
        reimbursementChoice: CONST.POLICY.REIMBURSEMENT_CHOICES.REIMBURSEMENT_MANUAL,
        isPolicyExpenseChatEnabled: true,
        ...overrides,
    });
}

const MATRIX: MatrixRow[] = [
    {
        label: 'Manual, reimburser = owner, actor is another admin',
        policy: buildPolicy({reimburser: OWNER_EMAIL}),
    },
    {
        label: 'Manual, no explicit reimburser, actor ≠ owner',
        // No `reimburser` set: isPayer falls back to policy.owner, which is not the actor.
        policy: buildPolicy({}),
    },
    {
        label: 'Manual, actor **is** the reimburser',
        policy: buildPolicy({reimburser: ACTOR_EMAIL}),
    },
    {
        label: 'Manual, no reimburser and no owner',
        // This is the shape the existing unit-test mock uses.
        policy: buildPolicy({owner: undefined, ownerAccountID: undefined}),
    },
    {
        label: 'Manual, actor is a Payments Admin',
        // PAYMENTS_ADMIN is a control-policy-only role, so the workspace must be Control.
        policy: buildPolicy({
            type: CONST.POLICY.TYPE.CORPORATE,
            role: CONST.POLICY.ROLE.PAYMENTS_ADMIN,
            reimburser: OWNER_EMAIL,
            employeeList: {[ACTOR_EMAIL]: {role: CONST.POLICY.ROLE.PAYMENTS_ADMIN, email: ACTOR_EMAIL}},
        }),
    },
    {
        label: 'Payments disabled (`REIMBURSEMENT_NO`)',
        policy: buildPolicy({reimbursementChoice: CONST.POLICY.REIMBURSEMENT_CHOICES.REIMBURSEMENT_NO}),
        // The only state a REIMBURSEMENT_NO report can be marked as paid from.
        prePaymentState: {stateNum: CONST.REPORT.STATE_NUM.SUBMITTED, statusNum: CONST.REPORT.STATUS_NUM.SUBMITTED},
    },
];

async function seedOnyx(report: Report, policy: Policy, withPayAction: boolean) {
    await Onyx.clear();
    await Onyx.set(ONYXKEYS.SESSION, {email: ACTOR_EMAIL, accountID: ACTOR_ACCOUNT_ID});
    await Onyx.set(ONYXKEYS.PERSONAL_DETAILS_LIST, {
        [ACTOR_ACCOUNT_ID]: {accountID: ACTOR_ACCOUNT_ID, login: ACTOR_EMAIL},
        [OWNER_ACCOUNT_ID]: {accountID: OWNER_ACCOUNT_ID, login: OWNER_EMAIL},
        [SUBMITTER_ACCOUNT_ID]: {accountID: SUBMITTER_ACCOUNT_ID, login: SUBMITTER_EMAIL},
    });
    await Onyx.set(`${ONYXKEYS.COLLECTION.REPORT}${REPORT_ID}`, report);
    await Onyx.set(`${ONYXKEYS.COLLECTION.REPORT}${CHAT_REPORT_ID}`, chatReport);
    await Onyx.set(`${ONYXKEYS.COLLECTION.POLICY}${POLICY_ID}`, policy);
    await Onyx.set(`${ONYXKEYS.COLLECTION.TRANSACTION}${TRANSACTION_ID}`, transaction);
    await Onyx.set(`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${REPORT_ID}`, withPayAction ? {[PAY_ACTION_ID]: payElsewhereAction} : {});
    await new Promise((resolve) => {
        process.nextTick(resolve);
    });
}

/** Can the actor mark this report as paid? */
async function canMarkAsPaid(row: MatrixRow): Promise<boolean> {
    const report = buildPrePaymentReport(row.prePaymentState);
    await seedOnyx(report, row.policy, false);
    const onlyShowPayElsewhere = row.policy.reimbursementChoice === CONST.POLICY.REIMBURSEMENT_CHOICES.REIMBURSEMENT_NO;
    return canIOUBePaid(report, chatReport, row.policy, {}, ACTOR_EMAIL, ACTOR_ACCOUNT_ID, [transaction], onlyShowPayElsewhere);
}

/** Once it is paid elsewhere, can the actor cancel that payment? */
async function canCancelPayment(row: MatrixRow): Promise<boolean> {
    const report = buildPaidReport();
    await seedOnyx(report, row.policy, true);
    const actions = getSecondaryReportActions({
        currentUserLogin: ACTOR_EMAIL,
        currentUserAccountID: ACTOR_ACCOUNT_ID,
        submitterLogin: SUBMITTER_EMAIL,
        report,
        chatReport,
        reportTransactions: [transaction],
        originalTransaction: transaction,
        violations: {},
        bankAccountList: {},
        policy: row.policy,
        isProduction: false,
    });
    return actions.includes(CONST.REPORT.SECONDARY_ACTIONS.CANCEL_PAYMENT);
}

const tick = (value: boolean) => (value ? '✅' : '❌');

describe('[#97577] Cancel payment availability matrix', () => {
    beforeAll(() => {
        Onyx.init({keys: ONYXKEYS});
    });

    it('prints the Mark as paid / Cancel payment matrix', async () => {
        const results: Array<{label: string; markAsPaid: boolean; cancelPayment: boolean}> = [];

        for (const row of MATRIX) {
            const markAsPaid = await canMarkAsPaid(row);
            const cancelPayment = await canCancelPayment(row);
            results.push({label: row.label, markAsPaid, cancelPayment});
        }

        const width = Math.max(...results.map((result) => result.label.length));
        const lines = [
            `| ${'workspace'.padEnd(width)} | Mark as paid | Cancel payment |`,
            `| ${'-'.repeat(width)} | ------------ | -------------- |`,
            ...results.map((result) => `| ${result.label.padEnd(width)} | ${tick(result.markAsPaid)}           | ${tick(result.cancelPayment)}             |`),
        ];
        console.log(`\n${lines.join('\n')}\n`);

        const broken = results.filter((result) => result.markAsPaid && !result.cancelPayment);
        console.log(
            broken.length > 0
                ? `BROKEN ROWS (can pay, cannot cancel): ${broken.length}\n${broken.map((row) => `  - ${row.label}`).join('\n')}\n`
                : 'BROKEN ROWS (can pay, cannot cancel): 0\n',
        );

        expect(results).toHaveLength(MATRIX.length);
    });

    it('every configuration that can mark as paid can also cancel that payment', async () => {
        for (const row of MATRIX) {
            const markAsPaid = await canMarkAsPaid(row);
            if (!markAsPaid) {
                continue;
            }
            const cancelPayment = await canCancelPayment(row);
            expect({row: row.label, canCancel: cancelPayment}).toEqual({row: row.label, canCancel: true});
        }
    });
});
