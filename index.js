const DerivAPI = require( '@deriv/deriv-api' );
const { default: bollingerBands, bollingerBandsArray } = require( 'binary-indicators/lib/bollingerBands' );
const { Subject } = require('rxjs');
const WebSocket =require ( 'ws' );

const api = new DerivAPI({
    connection: new WebSocket('wss://www.binaryqa40.com/websockets/v3?app_id=1009&l=EN&brand=deriv'),
});

const analysisStake = 50;
const realStake = 500;

const bbOptions = {
    periods: 40,
    stdDevUp: 2.5,
    stdDevDown: 2.5,
};

const bbs = (ticks, pip) => bollingerBandsArray(ticks.map(t => t.quote.value), {...bbOptions, pipSize: pip});
const bb = (ticks, pip) => bollingerBands(ticks.map(t => t.quote.value), {...bbOptions, pipSize: pip});

class Strategy {
    constructor(options) {
        this.options = options;
        const { api, ticks, profitEvent, bollingerBands, stake, symbol, pip, mult, type, real, ratio } = options;
        this.ratio = ratio;
        this.real = real;
        this.type = type;
        this.symbol = symbol;
        this.pip = pip;
        this.api = api;
        this.ticks = ticks;
        this.profitEvent = profitEvent;
        this.bollingerBands = bollingerBands;
        this.stake = stake;
        this.profit = 0;
        this.contracts = [];
        this.mult = mult;
    }

    init() {
        return this.createNewContract().catch((error) => {
            setTimeout(() => this.init(), 60000);
            console.log(error);
        });
    }

    async createNewContract() {
        const contract = await this.api.contract({
            amount: this.stake,
            currency: 'USD',
            basis: 'stake',
            contract_type: this.type,
            deal_cancellation: 0, duration_unit: 's',
            limit_order:{take_profit: this.stake * 0.1, stop_loss: this.stake * -0.1},
            multiplier: this.mult,
            product_type: 'basic',
            symbol: this.symbol,
        });

        this.contracts.push(contract);

        const subscriber = contract.onUpdate(() => {
            if (contract.status === 'proposal' && !this.purchased) {
                if (this.buyCondition(contract)) {
                    this.purchased = true;
                    this.buy(contract).catch(console.log);
                }
            } else {
                if (contract.is_open && this.sellCondition(contract)) {
                    this.sell(contract).catch(console.log);
                } else if (contract.is_closed) {
                    subscriber.unsubscribe();
                    contract.destroy();
                    this.profit += contract.profit.signed;
                    this.profitEvent.next({ name: this.name, contract, profit: this.profit });
                    if (!this.real) {
                        this.init();
                    }
                }
            }
        });
    }

    destroy() {
        this.contracts.forEach(c => c.destroy());
        this.contracts = [];
    }

    buy(contract) {
        console.log(`${this.name}, symbol: ${this.symbol}, ${this.type}, ${this.stake}`);
        return contract.buy();
    }

    sell(contract) {
        return contract.sell();
    }

    buyCondition(contract) {
    }

    sellCondition(contract) {
        const middles = bbs(this.ticks.list, this.pip).map(b => b[0]);

        let sign = middles.slice( -1 )[0] - middles.slice( -2 )[0];

        for (let i = 1; i <= 3; i++) {
            if (
                (sign > 0 && middles.slice( -i )[0] - middles.slice( -i - 1 )[0] < 0) ||
                (sign < 0 && middles.slice( -i )[0] - middles.slice( -i - 1 )[0] > 0)
            ) {
                console.log('Change of sign in the middle, selling', this.symbol, this.type, middles.slice(-3));
                return true;
            }
        }

        return false;
    }
}

class PassMiddle extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'pass middle';
        this.init();
    }

    buyCondition(contract) {
        const { type } = contract;
        const [ middle ] = bb(this.ticks.list, this.pip);
        const [ s0, s1, s2, s3, s4, s5 ] = this.ticks.list.slice(-6).map(t => t.quote.value);

        if (
            (type === 'MULTUP' && s0 < middle && s1 < middle && s2 < middle && s3 > middle && s4 > middle && s5 > middle) ||
            (type === 'MULTDOWN' && s0 > middle && s1 > middle && s2 > middle && s3 < middle && s4 < middle && s5 < middle)
        ) {
            return true;
        }

        return false;
    }
}

class TouchEdge extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'touch edge';
        this.init();
    }

    buyCondition(contract) {
        const { type } = contract;
        const [ middle, upper, lower ] = bb(this.ticks.list, this.pip);
        const [ spot ] = this.ticks.list.slice(-1).map(t => t.quote.value);

        if (
            (type === 'MULTUP' && spot >= upper) ||
            (type === 'MULTDOWN' && spot <= lower)
        ) {
            return true;
        }

        return false;
    }
}

class Trend extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'trend';
        this.init();
    }

    buyCondition(contract) {
        const [ oldSpot ] = this.ticks.list.slice(-1200).map(t => t.quote.value);
        const [ spot ] = this.ticks.list.slice(-1).map(t => t.quote.value);

        const diff = spot - oldSpot;

        if (Math.abs(diff) / spot < 0.003 * this.ratio) return false;

        if (
            (diff > 0 && contract.type === 'MULTUP') ||
            (diff < 0 && contract.type === 'MULTDOWN')
        ) {
            return true;
        }

        return false;
    }
}

class FastTrend extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'there is a fast trend';
        this.init();
    }

    buyCondition(contract) {
        const [ oldSpot ] = this.ticks.list.slice(-10).map(t => t.quote.value);
        const [ spot ] = this.ticks.list.slice(-1).map(t => t.quote.value);
        const [ middle, upper, lower ] = bb(this.ticks.list, this.pip);

        const diff = spot - oldSpot;

        if (Math.abs(diff) / spot < 0.002 * this.ratio) return false;

        if (Math.abs(upper - lower) / middle < 0.002 * this.ratio) return false;

        if (
            (diff > 0 && contract.type === 'MULTUP') ||
            (diff < 0 && contract.type === 'MULTDOWN')
        ) {
            return true;
        }

        return false;
    }
}

class SteepMiddle extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'middle changes are steep';
        this.init();
    }

    buyCondition(contract) {
        const [ previousMiddle ] = bb(this.ticks.list.slice(0, -60), this.pip);
        const [ middle ] = bb(this.ticks.list, this.pip);

        const diff = middle - previousMiddle;

        if (Math.abs(diff) / middle < 0.0005 * this.ratio) return false;

        if (
            (diff > 0 && contract.type === 'MULTUP') ||
            (diff < 0 && contract.type === 'MULTDOWN')
        ) {
            return true;
        }

        return false;
    }
}

class ConstantTrend extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'constant changes';
        this.init();
    }

    buyCondition(contract) {
        const middles = bbs(this.ticks.list, this.pip).map(b => b[0]);

        let sign = middles.slice( -1 )[0] - middles.slice( -2 )[0];

        for (let i = 1; i <= 60; i++) {
            if (sign > 0 && middles.slice( -i )[0] - middles.slice( -i - 1 )[0] < 0) return false;
            if (sign < 0 && middles.slice( -i )[0] - middles.slice( -i - 1 )[0] > 0) return false;
        }

        return true;
    }
}

class FastAndSteep extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'fast and steep';
        this.init();
    }

    buyCondition(contract) {
        return FastTrend.prototype.buyCondition.call(this, contract) &&
        SteepMiddle.prototype.buyCondition.call(this, contract);
    }
}

class SteepMiddleAndTouchEdge extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'spot passes middle and changes are steep';
        this.init();
    }

    buyCondition(contract) {
        return TouchEdge.prototype.buyCondition.call(this, contract) &&
        SteepMiddle.prototype.buyCondition.call(this, contract);
    }
}

class FastAndSlowTrends extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'there is fast and slow trends';
        this.init();
    }

    buyCondition(contract) {
        return FastTrend.prototype.buyCondition.call(this, contract) &&
        SteepMiddle.prototype.buyCondition.call(this, contract);
    }
}

class TrendAndTouchEdge extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'trend and touch edge';
        this.init();
    }

    buyCondition(contract) {
        return Trend.prototype.buyCondition.call(this, contract) &&
        TouchEdge.prototype.buyCondition.call(this, contract);
    }
}

class ConstantAndSteep extends Strategy {
    constructor(...args) {
        super(...args);
        this.name = 'constant and steep';
        this.init();
    }

    buyCondition(contract) {
        return SteepMiddle.prototype.buyCondition.call(this, contract) &&
        ConstantTrend.prototype.buyCondition.call(this, contract);
    }
}

async function main () {
    const symbols = await Promise.all([
        {symbol: 'R_10', pip: 3, mult: 500, type: 'MULTUP'  , ratio: 0.10 },
        {symbol: 'R_25', pip: 3, mult: 250, type: 'MULTUP'  , ratio: 0.25 },
        {symbol: 'R_50', pip: 4, mult: 100, type: 'MULTUP'  , ratio: 0.50 },
        {symbol: 'R_75', pip: 4, mult: 75 , type: 'MULTUP'  , ratio: 0.75 },
        {symbol: 'R_100', pip: 2, mult: 50, type: 'MULTUP'  , ratio: 1.00 },
        {symbol: 'R_10', pip: 3, mult: 500, type: 'MULTDOWN', ratio: 0.10 },
        {symbol: 'R_25', pip: 3, mult: 250, type: 'MULTDOWN', ratio: 0.25 },
        {symbol: 'R_50', pip: 4, mult: 100, type: 'MULTDOWN', ratio: 0.50 },
        {symbol: 'R_75', pip: 4, mult: 75 , type: 'MULTDOWN', ratio: 0.75 },
        {symbol: 'R_100', pip: 2, mult: 50, type: 'MULTDOWN', ratio: 1.00 },
    ].map(s => api.ticks(s.symbol).then(t => {return {...s, ticks: t}})));
        await api.basic.authorize('a1-Myy4fDZAFgAOr6IZZvAOOF1FDSWz4');

    const profitEvent = new Subject();

    const options = {
        api,
        profitEvent,
        stake: analysisStake,
    };

    let strategies = [];
    symbols.forEach(s => strategies.push(
        new FastAndSteep({...options, ...s}),
        new SteepMiddleAndTouchEdge({...options, ...s}),
        new FastAndSlowTrends({...options, ...s}),
        new TrendAndTouchEdge({...options, ...s}),
        new ConstantAndSteep({...options, ...s}),
    ));

    let currentStrategy;
    profitEvent.subscribe(({ name, contract, profit }) => {
        console.log(`* New profit for ${name}, ${contract.type}, ${contract.symbol.code}: ${profit}`);
        // Descending
        const sortedStrategies = strategies.sort((s1, s2) => s2.profit - s1.profit);
    
        if (sortedStrategies[0].profit <= 5) return;
        if (!currentStrategy || currentStrategy.name !== sortedStrategies[0].name || currentStrategy.type !== sortedStrategies[0].type || currentStrategy.symbol !== sortedStrategies[0].symbol) {
            if (currentStrategy) {
                currentStrategy.destroy();
                console.log(`* Old strategy: ${currentStrategy.name}, ${currentStrategy.type}, ${currentStrategy.symbol}, ${currentStrategy.profit}`);
            }
            const [bestStrategy] = sortedStrategies;
            currentStrategy = new bestStrategy.constructor({...bestStrategy.options, stake: realStake, real: true});
            console.log(`* New strategy: ${currentStrategy.name}, ${currentStrategy.type}, ${currentStrategy.symbol}`);
        }
    });

    await new Promise(() => {});
}

main().then(console.log).catch(console.log);
