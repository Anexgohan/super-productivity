/**
 * Counters and a day's metric (anex/app-actions), built as SimpleCounterService and the day's evaluation sheet build them.
 */
import { nanoid } from 'nanoid';
import {
  addSimpleCounter,
  deleteSimpleCounter,
  setSimpleCounterCounterForDate,
  updateSimpleCounter,
} from '../../../../src/app/features/simple-counter/store/simple-counter.actions';
import { selectSimpleCounterFeatureState } from '../../../../src/app/features/simple-counter/store/simple-counter.reducer';
import { EMPTY_SIMPLE_COUNTER } from '../../../../src/app/features/simple-counter/simple-counter.const';
import type {
  SimpleCounter,
  SimpleCounterState,
} from '../../../../src/app/features/simple-counter/simple-counter.model';
import { upsertMetric } from '../../../../src/app/features/metric/store/metric.actions';
import { selectMetricFeatureState } from '../../../../src/app/features/metric/store/metric.selectors';
import { DEFAULT_METRIC_FOR_DAY } from '../../../../src/app/features/metric/metric.const';
import type { MetricState } from '../../../../src/app/features/metric/metric.model';
import {
  ActionInputError,
  built,
  type BuildContext,
  type Builder,
} from './build-context';

type CounterAction =
  | 'addCounter'
  | 'updateCounter'
  | 'deleteCounter'
  | 'setCounterForDay'
  | 'setMetric';

const checkCounter = (ctx: BuildContext, id: string): void => {
  const counters = ctx.select(
    selectSimpleCounterFeatureState as never,
  ) as SimpleCounterState;
  if (!counters.entities[id]) throw new ActionInputError(`Counter not found: ${id}`, 404);
};

export const COUNTER_BUILDERS: { [N in CounterAction]: Builder<N> } = {
  // As the counter settings dialog's save of a new counter, then SimpleCounterService.addSimpleCounter.
  addCounter: (_ctx, settings) => {
    const id = nanoid();
    return {
      actions: [
        addSimpleCounter({
          simpleCounter: { ...EMPTY_SIMPLE_COUNTER, ...settings, id } as SimpleCounter,
        }),
      ],
      refs: { counterId: id },
    };
  },

  // As the counter settings dialog's save; the counts and the on state are not settings.
  updateCounter: (ctx, { counterId, changes }) => {
    checkCounter(ctx, counterId);
    return built(
      updateSimpleCounter({
        simpleCounter: { id: counterId, changes: changes as Partial<SimpleCounter> },
      }),
    );
  },

  // As SimpleCounterService.deleteSimpleCounter; its running timers are a device's own.
  deleteCounter: (ctx, { counterId }) => {
    checkCounter(ctx, counterId);
    return built(deleteSimpleCounter({ id: counterId }));
  },

  // As SimpleCounterService.setCounterForDate, from the counter's edit dialog.
  setCounterForDay: (ctx, { counterId, day, value }) => {
    checkCounter(ctx, counterId);
    return built(
      setSimpleCounterCounterForDate({ id: counterId, date: day, newVal: value }),
    );
  },

  // As the evaluation sheet's update: the day's metric, new or as it is, with the fields given.
  setMetric: (ctx, { day, changes }) => {
    const metrics = ctx.select(selectMetricFeatureState as never) as MetricState;
    const current = metrics.entities[day] ?? { id: day, ...DEFAULT_METRIC_FOR_DAY };
    return built(upsertMetric({ metric: { ...current, ...changes, id: day } }));
  },
};
