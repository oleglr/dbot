const DerivAPI = require( '@deriv/deriv-api' );
const { default: bollingerBands, bollingerBandsArray } = require( 'binary-indicators/lib/bollingerBands' );
const { Subject } = require('rxjs');
const WebSocket =require ( 'ws' );

const symbol = 'R_10';
const pipSize = 3;

const api = new DerivAPI({
    connection: new WebSocket('wss://www.binaryqa40.com/websockets/v3?app_id=1009&l=EN&brand=deriv'),
});

const log = (...args) => console.log(...args);

const analysisStake = 1;
const realStake = 10;

const bbOptions = {
    periods: 40,
    stdDevUp: 2.5,
    stdDevDown: 2.5,
    pipSize,
};

const bbs = ticks => bollingerBandsArray(ticks.map(t => t.quote.value), bbOptions);
const bb = ticks => bollingerBands(ticks.map(t => t.quote.value), bbOptions);

class Strategy {
    constructor({ api, ticks, profitEvent, bollingerBands, analysisStake }) {
        this.api = api;
        this.ticks = ticks;
        this.profitEvent = profitEvent;
        this.bollingerBands = bollingerBands;
        this.stake = analysisStake;
        this.proposalSubscribers = {};
        this.pocSubscribers = {};
        this.profit = 0;

        this.init();
    }

    async init() {
        await Promise.all([
            this.createNewProposal('MULTUP'),
            this.createNewProposal('MULTDOWN'),
        ]);
    }

    async createNewProposal(type) {
        this.proposal = await this.api.basic.subscribe({
            proposal: 1,
            amount: this.stake,
            currency: 'USD',
            basis: 'stake',
            contract_type: type,
            deal_cancellation: 0, duration_unit: 's',
            limit_order:{},
            multiplier: 100,
            product_type: 'basic',
            symbol,
        });

        this.proposalSubscribers[type] = this.proposal.subscribe((proposal) => {
            if (this.buyCondition(proposal)) {
                this.buy(proposal).then(() => {
                    this.proposalSubscribers[type].unsubscribe();
                }).catch(console.log);
            }
        });
    }

    async buy({ proposal: { id: buy, ask_price: price }, echo_req: { contract_type: type } }) {
        const purchase = await this.api.basic.buy({buy, price});

        this.poc = this.api.basic.subscribe({
            proposal_open_contract: 1,
            contract_id: purchase.contract_id,
        });

        this.pocSubscribers[type] = this.poc.subscribe(poc => {
            if (this.sellCondition(poc)) {
                this.pocSubscribers[type].unsubscribe();
                this.createNewProposal(type);
                this.sell(poc).then((sell) => {
                    this.profit += price - sell.sold_for;
                    log(`New profit for ${this.name}: ${this.profit}`);
                }).catch(console.log);
            } else if (poc.proposal_open_contract.is_sold) {
                this.pocSubscribers[type].unsubscribe();
                this.createNewProposal(type);
                log(poc);
                this.profit += poc.proposal_open_contract.profit;
                log(`New profit for ${this.name}: ${this.profit}`);
            }
        });
    }

    async sell({ proposal_open_contract: { contract_id, bid_price: price } }) {
        await this.api.basic.sell({ sell: contract_id, price })
    }

    buyCondition({ proposal: { ask_price: price} }) {
    }

    sellCondition({ proposal_open_contract: { profit } }) {
    }
}

class WhenPassMiddle extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'when pass middle';
    }
    buyCondition({ proposal: { ask_price: price }, echo_req: { contract_type: type } }) {
        const [ middle ] = bb(this.ticks.list);
        const [ previousSpot, spot ] = this.ticks.list.slice(-2).map(t => t.quote.value);

        if (type === 'MULTUP' && previousSpot < middle && spot > middle) {
            log('spot passed middle, rise');
            return true;
        }
        if (type === 'MULTDOWN' && previousSpot > middle && spot < middle) {
            log('spot passed middle, fall');
            return true;
        }

        return false;
    }

    sellCondition({ proposal_open_contract: { profit } }) {
        return profit > 0;
    }
}

async function main () {
    const ticks = await api.ticks(symbol);
    await api.basic.authorize('a1-Myy4fDZAFgAOr6IZZvAOOF1FDSWz4');
    /*
    const bollingerBands = bollingerBandsCreator(ticks.list.map(t => t.quote), );
*/
    const profitEvent = new Subject();

    const strategy = new WhenPassMiddle({
            api,
            ticks,
            profitEvent,
            analysisStake,
        });



    /*
    const strategies = [
        new WhenPassMiddle({
            api,
            ticks,
            profitEvent,
            bollingerBands,
            analysisStake,
        }),
        new WhenTouchEdge({
            api,
            ticks,
            profitEvent,
            bollingerBands,
            analysisStake,
        }),
        new WhenDownTrend({
            api,
            ticks,
            profitEvent,
            bollingerBands,
            analysisStake,
        }),
    ];

    let currentStrategy;
    profitEvent.subscribe(() => {
        const sortedStrategies = strategies.sort((s1, s2) => s1.profit - s2.profit);
    
        if (currentStrategy !== sortedStrategies[0]) {
            currentStrategy.stake = analysisStake;
            [currentStrategy] = sortedStrategies;
            currentStrategy.stake = realStake;
        }
    });
    */
}

main().then(console.log).catch(console.log);
