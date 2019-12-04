const DerivAPI = require( '@deriv/deriv-api' );
const { default: bollingerBands, bollingerBandsArray } = require( 'binary-indicators/lib/bollingerBands' );
const { Subject } = require('rxjs');
const WebSocket =require ( 'ws' );

const symbol = 'R_10';
const pipSize = 3;

const api = new DerivAPI({
    connection: new WebSocket('wss://www.binaryqa40.com/websockets/v3?app_id=1009&l=EN&brand=deriv'),
});

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
    constructor({ api, ticks, profitEvent, bollingerBands, stake }) {
        this.api = api;
        this.ticks = ticks;
        this.profitEvent = profitEvent;
        this.bollingerBands = bollingerBands;
        this.stake = stake;
        this.profit = 0;

        this.init();
    }

    async init() {
        await Promise.all([
            this.createNewContract('MULTUP'),
            this.createNewContract('MULTDOWN'),
        ]);
    }

    async createNewContract(type) {
        const contract = await this.api.contract({
            proposal: 1,
            amount: this.stake,
            currency: 'USD',
            basis: 'stake',
            contract_type: type,
            deal_cancellation: 0, duration_unit: 's',
            limit_order:{},
            multiplier: 500,
            product_type: 'basic',
            symbol,
        });

        const subscriber = contract.onUpdate(() => {
            if (contract.state === 'proposal') {
                if (this.buyCondition(contract)) {
                    this.buy(contract).catch(console.log);
                }
            } else {
                if (contract.is_open && this.sellCondition(contract)) {
                    this.sell(contract).catch(console.log);
                } else if (contract.is_closed) {
                    subscriber.unsubscribe();
                    this.createNewContract(contract.type);
                    this.profit += contract.profit.signed;
                    this.profitEvent.next({ name: this.name, contract });
                }
            }
        });
    }

    async buy(contract) {
        const purchase = await contract.buy();
    }

    async sell(contract) {
        return contract.sell();
    }

    buyCondition(contract) {
    }

    sellCondition(contract) {
        if (contract.profit.signed > this.stake * 1.5) return true;
        if (contract.profit.signed < -1 * this.stake) return true;
        return false;
    }
}

class WhenPassMiddle extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'when pass middle';
    }

    buy(contract) {
        if (contract.type === 'MULTUP') {
            console.log('spot passed middle, rise');
        } else {
            console.log('spot passed middle, fall');
        }
        return super.buy(contract);
    }

    buyCondition(contract) {
        const { type } = contract;
        const [ middle ] = bb(this.ticks.list);
        const [ previousSpot, spot ] = this.ticks.list.slice(-2).map(t => t.quote.value);

        if (
            (type === 'MULTUP' && previousSpot < middle && spot > middle) ||
            (type === 'MULTDOWN' && previousSpot > middle && spot < middle)
        ) {
            return true;
        }

        return false;
    }
}

class WhenTouchEdge extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'when touch edge';
    }

    buy(contract) {
        if (contract.type === 'MULTUP') {
            console.log('spot touched upper, rise');
        } else {
            console.log('spot touched lower, fall');
        }
        return super.buy(contract);
    }

    buyCondition(contract) {
        const { type } = contract;
        const [ middle, upper, lower ] = bb(this.ticks.list);
        const [ spot ] = this.ticks.list.slice(-1).map(t => t.quote.value);

        if (
            (type === 'MULTUP' && spot === upper) ||
            (type === 'MULTDOWN' && spot === lower)
        ) {
            return true;
        }

        return false;
    }
}

class WhenTrendAndPassMiddle extends WhenPassMiddle {
    constructor(...args) {
        super(...args);
        this.name = 'when trend and pass middle';
    }

    buy(contract) {
        if (contract.type === 'MULTUP') {
            console.log('spot passed middle, and there is a up trend');
        } else {
            console.log('spot passed middle, and there is a down trend');
        }
        return super.buy(contract);
    }

    buyCondition(contract) {
        const [ oldSpot ] = this.ticks.list.slice(-1200).map(t => t.quote.value);
        const [ spot ] = this.ticks.list.slice(-1).map(t => t.quote.value);
        const passedMiddle = super.buyCondition(contract);

        if (!passedMiddle) return false;

        const diff = spot - oldSpot;

        if (Math.abs(diff) / spot < 0.001) return false;

        if (
            (diff > 0 && contract.type === 'MULTUP') ||
            (diff < 0 && contract.type === 'MULTDOWN')
        ) {
            return true;
        }

        return false;
    }
}

class WhenFastTrend extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'when there is a fast trend';
    }

    buy(contract) {
        if (contract.type === 'MULTUP') {
            console.log('Fast trend up');
        } else {
            console.log('Fast trend down');
        }
        return super.buy(contract);
    }

    buyCondition(contract) {
        const [ oldSpot ] = this.ticks.list.slice(-10).map(t => t.quote.value);
        const [ spot ] = this.ticks.list.slice(-1).map(t => t.quote.value);
        const [ middle, upper, lower ] = bb(this.ticks.list);

        const diff = spot - oldSpot;

        if (Math.abs(diff) / spot < 0.0003) return false;

        if (Math.abs(upper - lower) / middle < 0.0006) return false;

        if (
            (diff > 0 && contract.type === 'MULTUP') ||
            (diff < 0 && contract.type === 'MULTDOWN')
        ) {
            return true;
        }

        return false;
    }
}

async function main () {
    const ticks = await api.ticks(symbol);
    await api.basic.authorize('a1-Myy4fDZAFgAOr6IZZvAOOF1FDSWz4');

    const profitEvent = new Subject();

    const options = {
        api,
        ticks,
        profitEvent,
        stake: analysisStake,
    };
    const strategies = [
        new WhenPassMiddle(options),
        new WhenTouchEdge(options),
        new WhenTrendAndPassMiddle(options),
        new WhenFastTrend(options),
    ];

    let currentStrategy;
    profitEvent.subscribe(({ name, contract }) => {
        console.log(`New profit for ${name}, ${contract.type}: ${contract.profit.signed}`);
        // Descending
        const sortedStrategies = strategies.sort((s1, s2) => s2.profit - s1.profit);
    
        if (!currentStrategy || currentStrategy.name !== sortedStrategies[0].name) {
            if (currentStrategy) {
                console.log(`Old strategy: ${currentStrategy.name}`);
            }
            const [bestStrategy] = sortedStrategies;
            currentStrategy = new bestStrategy.constructor({...options, stake: realStake});
            console.log(`New strategy: ${currentStrategy.name}`);
        }
    });

    await new Promise(() => {});
}

main().then(console.log).catch(console.log);
