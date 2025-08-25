type ObjectType<T> =
  Extract<T, Record<string, any>> extends never
    ? Record<string, any>
    : Extract<T, Record<string, any>>;

type NotArray<T> = T extends any[] ? never : T;
type NotFunction<T> = T extends (...args: any[]) => any ? never : T;
type PlainObject<T> = T extends object
  ? NotFunction<T> extends never
    ? never
    : NotArray<T> extends never
      ? never
      : T
  : never;

type MappersType<T> = {
  boolean: T extends boolean
    ? (value: boolean) => Partial<ObjectType<T>>
    : never;
  function: T extends (...args: any[]) => any
    ? (value: (...args: any[]) => any) => Partial<ObjectType<T>>
    : never;
  number: T extends number ? (value: number) => Partial<ObjectType<T>> : never;
  object?: PlainObject<T> extends never
    ? never
    : (
        value: Partial<PlainObject<T>>,
        defaultValue: PlainObject<T>,
      ) => Partial<ObjectType<T>>;
  string: T extends string ? (value: string) => Partial<ObjectType<T>> : never;
} extends infer U
  ? { [K in keyof U as U[K] extends never ? never : K]: U[K] }
  : never;

type IsObjectOnly<T> = T extends Record<string, any> | undefined
  ? Extract<
      T,
      string | boolean | number | ((...args: any[]) => any)
    > extends never
    ? true
    : false
  : false;

export type ValueToObject = <
  T extends
    | undefined
    | string
    | boolean
    | number
    | ((...args: any[]) => any)
    | Record<string, any>,
>(
  args: {
    defaultValue: ObjectType<T>;
    value: T;
  } & (IsObjectOnly<T> extends true
    ? {
        mappers?: MappersType<T>;
      }
    : {
        mappers: MappersType<T>;
      }),
) => PlainObject<T>;

const isPlainObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof value !== 'function';

const mergeResult = <T>(
  result: ObjectType<T>,
  mapped: Record<string, any>,
): ObjectType<T> => {
  for (const [key, value] of Object.entries(mapped)) {
    if (value !== undefined && value !== '') {
      (result as Record<string, any>)[key] = value;
    }
  }
  return result;
};

export const valueToObject: ValueToObject = ({
  defaultValue,
  mappers,
  value,
}) => {
  let result = { ...defaultValue };

  switch (typeof value) {
    case 'boolean':
      if (mappers && 'boolean' in mappers) {
        const mapper = mappers.boolean as (
          value: boolean,
        ) => Record<string, any>;
        result = mergeResult(result, mapper(value));
      }
      break;
    case 'function':
      if (mappers && 'function' in mappers) {
        const mapper = mappers.function as (
          value: (...args: any[]) => any,
        ) => Record<string, any>;
        result = mergeResult(result, mapper(value as (...args: any[]) => any));
      }
      break;
    case 'number':
      if (mappers && 'number' in mappers) {
        const mapper = mappers.number as (value: number) => Record<string, any>;
        result = mergeResult(result, mapper(value));
      }
      break;
    case 'string':
      if (mappers && 'string' in mappers) {
        const mapper = mappers.string as (value: string) => Record<string, any>;
        result = mergeResult(result, mapper(value));
      }
      break;
    case 'object':
      if (isPlainObject(value)) {
        if (
          mappers &&
          'object' in mappers &&
          typeof mappers.object === 'function'
        ) {
          const mapper = mappers.object as (
            value: Record<string, any>,
            defaultValue: ObjectType<any>,
          ) => Partial<ObjectType<any>>;
          result = mergeResult(result, mapper(value, defaultValue));
        } else {
          result = mergeResult(result, value);
        }
      }
      break;
  }

  return result as any;
};
