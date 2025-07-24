import ts from 'typescript';

import { compiler } from '../../compiler';
import type { Identifier } from '../../generate/file/types';
import { deduplicateSchema } from '../../ir/schema';
import type { IR } from '../../ir/types';
import type { StringCase, StringName } from '../../types/case';
import { numberRegExp } from '../../utils/regexp';
import { createSchemaComment } from '../shared/utils/schema';
import { identifiers, valibotId } from './constants';
import {
  INTEGER_FORMATS,
  isIntegerFormat,
  needsBigIntForFormat,
  numberParameter,
} from './number-helpers';
import { operationToValibotSchema } from './operation';
import type { ValibotPlugin } from './types';

interface SchemaWithType<T extends Required<IR.SchemaObject>['type']>
  extends Omit<IR.SchemaObject, 'type'> {
  type: Extract<Required<IR.SchemaObject>['type'], T>;
}

export interface State {
  circularReferenceTracker: Set<string>;
  hasCircularReference: boolean;
  nameCase: StringCase;
  nameTransformer: StringName;
}

const pipesToExpression = (pipes: Array<ts.Expression>) => {
  if (pipes.length === 1) {
    return pipes[0]!;
  }

  const expression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.methods.pipe,
    }),
    parameters: pipes,
  });
  return expression;
};

const arrayTypeToValibotSchema = ({
  plugin,
  schema,
  state,
}: {
  plugin: ValibotPlugin['Instance'];
  schema: SchemaWithType<'array'>;
  state: State;
}): ts.Expression => {
  const functionName = compiler.propertyAccessExpression({
    expression: identifiers.v,
    name: identifiers.schemas.array,
  });

  const pipes: Array<ts.CallExpression> = [];

  if (!schema.items) {
    const expression = compiler.callExpression({
      functionName,
      parameters: [
        unknownTypeToValibotSchema({
          schema: {
            type: 'unknown',
          },
        }),
      ],
    });
    pipes.push(expression);
  } else {
    schema = deduplicateSchema({ schema });

    // at least one item is guaranteed
    const itemExpressions = schema.items!.map((item) => {
      const schemaPipes = schemaToValibotSchema({
        plugin,
        schema: item,
        state,
      });
      return pipesToExpression(schemaPipes);
    });

    if (itemExpressions.length === 1) {
      const expression = compiler.callExpression({
        functionName,
        parameters: itemExpressions,
      });
      pipes.push(expression);
    } else {
      if (schema.logicalOperator === 'and') {
        // TODO: parser - handle intersection
        // return compiler.typeArrayNode(
        //   compiler.typeIntersectionNode({ types: itemExpressions }),
        // );
      }

      // TODO: parser - handle union
      // return compiler.typeArrayNode(compiler.typeUnionNode({ types: itemExpressions }));

      const expression = compiler.callExpression({
        functionName,
        parameters: [
          unknownTypeToValibotSchema({
            schema: {
              type: 'unknown',
            },
          }),
        ],
      });
      pipes.push(expression);
    }
  }

  if (schema.minItems === schema.maxItems && schema.minItems !== undefined) {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.length,
      }),
      parameters: [compiler.valueToExpression({ value: schema.minItems })],
    });
    pipes.push(expression);
  } else {
    if (schema.minItems !== undefined) {
      const expression = compiler.callExpression({
        functionName: compiler.propertyAccessExpression({
          expression: identifiers.v,
          name: identifiers.actions.minLength,
        }),
        parameters: [compiler.valueToExpression({ value: schema.minItems })],
      });
      pipes.push(expression);
    }

    if (schema.maxItems !== undefined) {
      const expression = compiler.callExpression({
        functionName: compiler.propertyAccessExpression({
          expression: identifiers.v,
          name: identifiers.actions.maxLength,
        }),
        parameters: [compiler.valueToExpression({ value: schema.maxItems })],
      });
      pipes.push(expression);
    }
  }

  return pipesToExpression(pipes);
};

const booleanTypeToValibotSchema = ({
  schema,
}: {
  schema: SchemaWithType<'boolean'>;
}) => {
  if (typeof schema.const === 'boolean') {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.schemas.literal,
      }),
      parameters: [compiler.ots.boolean(schema.const)],
    });
    return expression;
  }

  const expression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.schemas.boolean,
    }),
  });
  return expression;
};

const enumTypeToValibotSchema = ({
  schema,
}: {
  schema: SchemaWithType<'enum'>;
}): ts.CallExpression => {
  const enumMembers: Array<ts.LiteralExpression> = [];

  let isNullable = false;

  for (const item of schema.items ?? []) {
    // Zod supports only string enums
    if (item.type === 'string' && typeof item.const === 'string') {
      enumMembers.push(
        compiler.stringLiteral({
          text: item.const,
        }),
      );
    } else if (item.type === 'null' || item.const === null) {
      isNullable = true;
    }
  }

  if (!enumMembers.length) {
    return unknownTypeToValibotSchema({
      schema: {
        type: 'unknown',
      },
    });
  }

  let resultExpression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.schemas.picklist,
    }),
    parameters: [
      compiler.arrayLiteralExpression({
        elements: enumMembers,
        multiLine: false,
      }),
    ],
  });

  if (isNullable) {
    resultExpression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.schemas.nullable,
      }),
      parameters: [resultExpression],
    });
  }

  return resultExpression;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const neverTypeToValibotSchema = (_props: {
  schema: SchemaWithType<'never'>;
}) => {
  const expression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.schemas.never,
    }),
  });
  return expression;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const nullTypeToValibotSchema = (_props: {
  schema: SchemaWithType<'null'>;
}) => {
  const expression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.schemas.null,
    }),
  });
  return expression;
};

const numberTypeToValibotSchema = ({
  schema,
}: {
  schema: SchemaWithType<'integer' | 'number'>;
}) => {
  const format = schema.format;
  const isInteger = schema.type === 'integer';
  const isBigInt = needsBigIntForFormat(format);
  const formatInfo = isIntegerFormat(format) ? INTEGER_FORMATS[format] : null;

  // Return early if const is defined since we can create a literal type directly without additional validation
  if (schema.const !== undefined && schema.const !== null) {
    const constValue = schema.const;
    let literalValue;

    // Case 1: Number with no format -> generate literal with the number
    if (typeof constValue === 'number' && !format) {
      literalValue = compiler.ots.number(constValue);
    }
    // Case 2: Number with format -> check if format needs BigInt, generate appropriate literal
    else if (typeof constValue === 'number' && format) {
      if (isBigInt) {
        // Format requires BigInt, convert number to BigInt
        literalValue = compiler.callExpression({
          functionName: 'BigInt',
          parameters: [compiler.ots.string(constValue.toString())],
        });
      } else {
        // Regular format, use number as-is
        literalValue = compiler.ots.number(constValue);
      }
    }
    // Case 3: Format that allows string -> generate BigInt literal (for int64/uint64 formats)
    else if (typeof constValue === 'string' && isBigInt) {
      // Remove 'n' suffix if present in string
      const cleanString = constValue.endsWith('n')
        ? constValue.slice(0, -1)
        : constValue;
      literalValue = compiler.callExpression({
        functionName: 'BigInt',
        parameters: [compiler.ots.string(cleanString)],
      });
    }
    // Case 4: Const is typeof bigint (literal) -> transform from literal to BigInt()
    else if (typeof constValue === 'bigint') {
      // Convert BigInt to string and remove 'n' suffix that toString() adds
      const bigintString = constValue.toString();
      const cleanString = bigintString.endsWith('n')
        ? bigintString.slice(0, -1)
        : bigintString;
      literalValue = compiler.callExpression({
        functionName: 'BigInt',
        parameters: [compiler.ots.string(cleanString)],
      });
    }
    // Default case: use value as-is for other types
    else {
      literalValue = compiler.valueToExpression({ value: constValue });
    }

    return compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.schemas.literal,
      }),
      parameters: [literalValue],
    });
  }

  const pipes: Array<ts.CallExpression> = [];

  // For bigint formats (int64, uint64), create union of number, string, and bigint with transform
  if (isBigInt) {
    const unionExpression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.schemas.union,
      }),
      parameters: [
        compiler.arrayLiteralExpression({
          elements: [
            compiler.callExpression({
              functionName: compiler.propertyAccessExpression({
                expression: identifiers.v,
                name: identifiers.schemas.number,
              }),
            }),
            compiler.callExpression({
              functionName: compiler.propertyAccessExpression({
                expression: identifiers.v,
                name: identifiers.schemas.string,
              }),
            }),
            compiler.callExpression({
              functionName: compiler.propertyAccessExpression({
                expression: identifiers.v,
                name: identifiers.schemas.bigInt,
              }),
            }),
          ],
          multiLine: false,
        }),
      ],
    });
    pipes.push(unionExpression);

    // Add transform to convert to BigInt
    const transformExpression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.transform,
      }),
      parameters: [
        compiler.arrowFunction({
          parameters: [{ name: 'x' }],
          statements: compiler.callExpression({
            functionName: 'BigInt',
            parameters: [compiler.identifier({ text: 'x' })],
          }),
        }),
      ],
    });
    pipes.push(transformExpression);
  } else {
    // For regular number formats, use number schema
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.schemas.number,
      }),
    });
    pipes.push(expression);
  }

  // Add integer validation for integer types (except when using bigint union)
  if (!isBigInt && isInteger) {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.integer,
      }),
    });
    pipes.push(expression);
  }

  // Add format-specific range validations
  if (formatInfo) {
    const minValue = formatInfo.min;
    const maxValue = formatInfo.max;
    const minErrorMessage = formatInfo.minError;
    const maxErrorMessage = formatInfo.maxError;

    // Add minimum value validation
    const minExpression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.minValue,
      }),
      parameters: [
        isBigInt
          ? compiler.callExpression({
              functionName: 'BigInt',
              parameters: [compiler.ots.string(minValue.toString())],
            })
          : compiler.ots.number(minValue as number),
        compiler.ots.string(minErrorMessage),
      ],
    });
    pipes.push(minExpression);

    // Add maximum value validation
    const maxExpression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.maxValue,
      }),
      parameters: [
        isBigInt
          ? compiler.callExpression({
              functionName: 'BigInt',
              parameters: [compiler.ots.string(maxValue.toString())],
            })
          : compiler.ots.number(maxValue as number),
        compiler.ots.string(maxErrorMessage),
      ],
    });
    pipes.push(maxExpression);
  }

  if (schema.exclusiveMinimum !== undefined) {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.gtValue,
      }),
      parameters: [
        numberParameter({ isBigInt, value: schema.exclusiveMinimum }),
      ],
    });
    pipes.push(expression);
  } else if (schema.minimum !== undefined) {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.minValue,
      }),
      parameters: [numberParameter({ isBigInt, value: schema.minimum })],
    });
    pipes.push(expression);
  }

  if (schema.exclusiveMaximum !== undefined) {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.ltValue,
      }),
      parameters: [
        numberParameter({ isBigInt, value: schema.exclusiveMaximum }),
      ],
    });
    pipes.push(expression);
  } else if (schema.maximum !== undefined) {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.maxValue,
      }),
      parameters: [numberParameter({ isBigInt, value: schema.maximum })],
    });
    pipes.push(expression);
  }

  return pipesToExpression(pipes);
};

const objectTypeToValibotSchema = ({
  plugin,
  schema,
  state,
}: {
  plugin: ValibotPlugin['Instance'];
  schema: SchemaWithType<'object'>;
  state: State;
}): {
  anyType: string;
  expression: ts.CallExpression;
} => {
  // TODO: parser - handle constants
  const properties: Array<ts.PropertyAssignment> = [];

  const required = schema.required ?? [];

  for (const name in schema.properties) {
    const property = schema.properties[name]!;
    const isRequired = required.includes(name);

    const schemaPipes = schemaToValibotSchema({
      optional: !isRequired,
      plugin,
      schema: property,
      state,
    });

    numberRegExp.lastIndex = 0;
    let propertyName;
    if (numberRegExp.test(name)) {
      // For numeric literals, we'll handle negative numbers by using a string literal
      // instead of trying to use a PrefixUnaryExpression
      propertyName = name.startsWith('-')
        ? ts.factory.createStringLiteral(name)
        : ts.factory.createNumericLiteral(name);
    } else {
      propertyName = name;
    }
    // TODO: parser - abstract safe property name logic
    if (
      ((name.match(/^[0-9]/) && name.match(/\D+/g)) || name.match(/\W/g)) &&
      !name.startsWith("'") &&
      !name.endsWith("'")
    ) {
      propertyName = `'${name}'`;
    }
    properties.push(
      compiler.propertyAssignment({
        initializer: pipesToExpression(schemaPipes),
        name: propertyName,
      }),
    );
  }

  if (
    schema.additionalProperties &&
    schema.additionalProperties.type === 'object' &&
    !Object.keys(properties).length
  ) {
    const pipes = schemaToValibotSchema({
      plugin,
      schema: schema.additionalProperties,
      state,
    });
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.schemas.record,
      }),
      parameters: [
        compiler.callExpression({
          functionName: compiler.propertyAccessExpression({
            expression: identifiers.v,
            name: identifiers.schemas.string,
          }),
          parameters: [],
        }),
        pipesToExpression(pipes),
      ],
    });
    return {
      anyType: 'AnyZodObject',
      expression,
    };
  }

  const expression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.schemas.object,
    }),
    parameters: [ts.factory.createObjectLiteralExpression(properties, true)],
  });
  return {
    // Zod uses AnyZodObject here, maybe we want to be more specific too
    anyType: identifiers.types.GenericSchema.text,
    expression,
  };
};

const stringTypeToValibotSchema = ({
  schema,
}: {
  schema: SchemaWithType<'string'>;
}) => {
  if (typeof schema.const === 'string') {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.schemas.literal,
      }),
      parameters: [compiler.ots.string(schema.const)],
    });
    return expression;
  }

  const pipes: Array<ts.CallExpression> = [];

  const expression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.schemas.string,
    }),
  });
  pipes.push(expression);

  if (schema.format) {
    switch (schema.format) {
      case 'date':
        pipes.push(
          compiler.callExpression({
            functionName: compiler.propertyAccessExpression({
              expression: identifiers.v,
              name: identifiers.actions.isoDate,
            }),
          }),
        );
        break;
      case 'date-time':
        pipes.push(
          compiler.callExpression({
            functionName: compiler.propertyAccessExpression({
              expression: identifiers.v,
              name: identifiers.actions.isoTimestamp,
            }),
          }),
        );
        break;
      case 'ipv4':
      case 'ipv6':
        pipes.push(
          compiler.callExpression({
            functionName: compiler.propertyAccessExpression({
              expression: identifiers.v,
              name: identifiers.actions.ip,
            }),
          }),
        );
        break;
      case 'uri':
        pipes.push(
          compiler.callExpression({
            functionName: compiler.propertyAccessExpression({
              expression: identifiers.v,
              name: identifiers.actions.url,
            }),
          }),
        );
        break;
      case 'email':
      case 'time':
      case 'uuid':
        pipes.push(
          compiler.callExpression({
            functionName: compiler.propertyAccessExpression({
              expression: identifiers.v,
              name: compiler.identifier({ text: schema.format }),
            }),
          }),
        );
        break;
    }
  }

  if (schema.minLength === schema.maxLength && schema.minLength !== undefined) {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.length,
      }),
      parameters: [compiler.valueToExpression({ value: schema.minLength })],
    });
    pipes.push(expression);
  } else {
    if (schema.minLength !== undefined) {
      const expression = compiler.callExpression({
        functionName: compiler.propertyAccessExpression({
          expression: identifiers.v,
          name: identifiers.actions.minLength,
        }),
        parameters: [compiler.valueToExpression({ value: schema.minLength })],
      });
      pipes.push(expression);
    }

    if (schema.maxLength !== undefined) {
      const expression = compiler.callExpression({
        functionName: compiler.propertyAccessExpression({
          expression: identifiers.v,
          name: identifiers.actions.maxLength,
        }),
        parameters: [compiler.valueToExpression({ value: schema.maxLength })],
      });
      pipes.push(expression);
    }
  }

  if (schema.pattern) {
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.actions.regex,
      }),
      parameters: [compiler.regularExpressionLiteral({ text: schema.pattern })],
    });
    pipes.push(expression);
  }

  return pipesToExpression(pipes);
};

const tupleTypeToValibotSchema = ({
  plugin,
  schema,
  state,
}: {
  plugin: ValibotPlugin['Instance'];
  schema: SchemaWithType<'tuple'>;
  state: State;
}) => {
  if (schema.const && Array.isArray(schema.const)) {
    const tupleElements = schema.const.map((value) =>
      compiler.callExpression({
        functionName: compiler.propertyAccessExpression({
          expression: identifiers.v,
          name: identifiers.schemas.literal,
        }),
        parameters: [compiler.valueToExpression({ value })],
      }),
    );
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.schemas.tuple,
      }),
      parameters: [
        compiler.arrayLiteralExpression({
          elements: tupleElements,
        }),
      ],
    });
    return expression;
  }

  if (schema.items) {
    const tupleElements = schema.items.map((item) => {
      const schemaPipes = schemaToValibotSchema({
        plugin,
        schema: item,
        state,
      });
      return pipesToExpression(schemaPipes);
    });
    const expression = compiler.callExpression({
      functionName: compiler.propertyAccessExpression({
        expression: identifiers.v,
        name: identifiers.schemas.tuple,
      }),
      parameters: [
        compiler.arrayLiteralExpression({
          elements: tupleElements,
        }),
      ],
    });
    return expression;
  }

  return unknownTypeToValibotSchema({
    schema: {
      type: 'unknown',
    },
  });
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const undefinedTypeToValibotSchema = (_props: {
  schema: SchemaWithType<'undefined'>;
}) => {
  const expression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.schemas.undefined,
    }),
  });
  return expression;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const unknownTypeToValibotSchema = (_props: {
  schema: SchemaWithType<'unknown'>;
}) => {
  const expression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.schemas.unknown,
    }),
  });
  return expression;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const voidTypeToValibotSchema = (_props: {
  schema: SchemaWithType<'void'>;
}) => {
  const expression = compiler.callExpression({
    functionName: compiler.propertyAccessExpression({
      expression: identifiers.v,
      name: identifiers.schemas.void,
    }),
  });
  return expression;
};

const schemaTypeToValibotSchema = ({
  plugin,
  schema,
  state,
}: {
  plugin: ValibotPlugin['Instance'];
  schema: IR.SchemaObject;
  state: State;
}): {
  anyType?: string;
  expression: ts.Expression;
} => {
  switch (schema.type as Required<IR.SchemaObject>['type']) {
    case 'array':
      return {
        expression: arrayTypeToValibotSchema({
          plugin,
          schema: schema as SchemaWithType<'array'>,
          state,
        }),
      };
    case 'boolean':
      return {
        expression: booleanTypeToValibotSchema({
          schema: schema as SchemaWithType<'boolean'>,
        }),
      };
    case 'enum':
      return {
        expression: enumTypeToValibotSchema({
          schema: schema as SchemaWithType<'enum'>,
        }),
      };
    case 'integer':
    case 'number':
      return {
        expression: numberTypeToValibotSchema({
          schema: schema as SchemaWithType<'integer' | 'number'>,
        }),
      };
    case 'never':
      return {
        expression: neverTypeToValibotSchema({
          schema: schema as SchemaWithType<'never'>,
        }),
      };
    case 'null':
      return {
        expression: nullTypeToValibotSchema({
          schema: schema as SchemaWithType<'null'>,
        }),
      };
    case 'object':
      return objectTypeToValibotSchema({
        plugin,
        schema: schema as SchemaWithType<'object'>,
        state,
      });
    case 'string':
      // For string schemas with int64/uint64 formats, use number handler to generate union with transform
      if (schema.format === 'int64' || schema.format === 'uint64') {
        return {
          expression: numberTypeToValibotSchema({
            schema: schema as SchemaWithType<'integer' | 'number'>,
          }),
        };
      }
      return {
        expression: stringTypeToValibotSchema({
          schema: schema as SchemaWithType<'string'>,
        }),
      };
    case 'tuple':
      return {
        expression: tupleTypeToValibotSchema({
          plugin,
          schema: schema as SchemaWithType<'tuple'>,
          state,
        }),
      };
    case 'undefined':
      return {
        expression: undefinedTypeToValibotSchema({
          schema: schema as SchemaWithType<'undefined'>,
        }),
      };
    case 'unknown':
      return {
        expression: unknownTypeToValibotSchema({
          schema: schema as SchemaWithType<'unknown'>,
        }),
      };
    case 'void':
      return {
        expression: voidTypeToValibotSchema({
          schema: schema as SchemaWithType<'void'>,
        }),
      };
  }
};

export const schemaToValibotSchema = ({
  $ref,
  identifier: _identifier,
  optional,
  plugin,
  schema,
  state,
}: {
  /**
   * When $ref is supplied, a node will be emitted to the file.
   */
  $ref?: string;
  identifier?: Identifier;
  /**
   * Accept `optional` to handle optional object properties. We can't handle
   * this inside the object function because `.optional()` must come before
   * `.default()` which is handled in this function.
   */
  optional?: boolean;
  plugin: ValibotPlugin['Instance'];
  schema: IR.SchemaObject;
  state: State;
}): Array<ts.Expression> => {
  const file = plugin.context.file({ id: valibotId })!;

  let anyType: string | undefined;
  let identifier: ReturnType<typeof file.identifier> | undefined = _identifier;
  let pipes: Array<ts.Expression> = [];

  if ($ref) {
    state.circularReferenceTracker.add($ref);

    if (!identifier) {
      identifier = file.identifier({
        $ref,
        case: state.nameCase,
        create: true,
        nameTransformer: state.nameTransformer,
        namespace: 'value',
      });
    }
  }

  if (schema.$ref) {
    const isCircularReference = state.circularReferenceTracker.has(schema.$ref);

    // if $ref hasn't been processed yet, inline it to avoid the
    // "Block-scoped variable used before its declaration." error
    // this could be (maybe?) fixed by reshuffling the generation order
    let identifierRef = file.identifier({
      $ref: schema.$ref,
      case: state.nameCase,
      nameTransformer: state.nameTransformer,
      namespace: 'value',
    });

    if (!identifierRef.name) {
      const ref = plugin.context.resolveIrRef<IR.SchemaObject>(schema.$ref);
      const schemaPipes = schemaToValibotSchema({
        $ref: schema.$ref,
        plugin,
        schema: ref,
        state,
      });
      pipes.push(...schemaPipes);

      identifierRef = file.identifier({
        $ref: schema.$ref,
        case: state.nameCase,
        nameTransformer: state.nameTransformer,
        namespace: 'value',
      });
    }

    // if `identifierRef.name` is falsy, we already set expression above
    if (identifierRef.name) {
      const refIdentifier = compiler.identifier({ text: identifierRef.name });
      if (isCircularReference) {
        const lazyExpression = compiler.callExpression({
          functionName: compiler.propertyAccessExpression({
            expression: identifiers.v,
            name: identifiers.schemas.lazy,
          }),
          parameters: [
            compiler.arrowFunction({
              statements: [
                compiler.returnStatement({
                  expression: refIdentifier,
                }),
              ],
            }),
          ],
        });
        pipes.push(lazyExpression);
        state.hasCircularReference = true;
      } else {
        pipes.push(refIdentifier);
      }
    }
  } else if (schema.type) {
    const valibotSchema = schemaTypeToValibotSchema({ plugin, schema, state });
    anyType = valibotSchema.anyType;
    pipes.push(valibotSchema.expression);

    if (plugin.config.metadata && schema.description) {
      const expression = compiler.callExpression({
        functionName: compiler.propertyAccessExpression({
          expression: identifiers.v,
          name: identifiers.actions.metadata,
        }),
        parameters: [
          compiler.objectExpression({
            obj: [
              {
                key: 'description',
                value: compiler.stringLiteral({ text: schema.description }),
              },
            ],
          }),
        ],
      });
      pipes.push(expression);
    }
  } else if (schema.items) {
    schema = deduplicateSchema({ schema });

    if (schema.items) {
      const itemTypes = schema.items.map((item) => {
        const schemaPipes = schemaToValibotSchema({
          plugin,
          schema: item,
          state,
        });
        return pipesToExpression(schemaPipes);
      });

      if (schema.logicalOperator === 'and') {
        const intersectExpression = compiler.callExpression({
          functionName: compiler.propertyAccessExpression({
            expression: identifiers.v,
            name: identifiers.schemas.intersect,
          }),
          parameters: [
            compiler.arrayLiteralExpression({
              elements: itemTypes,
            }),
          ],
        });
        pipes.push(intersectExpression);
      } else {
        const unionExpression = compiler.callExpression({
          functionName: compiler.propertyAccessExpression({
            expression: identifiers.v,
            name: identifiers.schemas.union,
          }),
          parameters: [
            compiler.arrayLiteralExpression({
              elements: itemTypes,
            }),
          ],
        });
        pipes.push(unionExpression);
      }
    } else {
      const schemaPipes = schemaToValibotSchema({
        plugin,
        schema,
        state,
      });
      pipes.push(...schemaPipes);
    }
  } else {
    // catch-all fallback for failed schemas
    const valibotSchema = schemaTypeToValibotSchema({
      plugin,
      schema: {
        type: 'unknown',
      },
      state,
    });
    anyType = valibotSchema.anyType;
    pipes.push(valibotSchema.expression);
  }

  if ($ref) {
    state.circularReferenceTracker.delete($ref);
  }

  if (pipes.length) {
    if (schema.accessScope === 'read') {
      const readonlyExpression = compiler.callExpression({
        functionName: compiler.propertyAccessExpression({
          expression: identifiers.v,
          name: identifiers.actions.readonly,
        }),
      });
      pipes.push(readonlyExpression);
    }
  }

  if (pipes.length) {
    let callParameter: ts.Expression | undefined;

    if (schema.default !== undefined) {
      const isBigInt = schema.type === 'integer' && schema.format === 'int64';
      callParameter = numberParameter({ isBigInt, value: schema.default });
      if (callParameter) {
        pipes = [
          compiler.callExpression({
            functionName: compiler.propertyAccessExpression({
              expression: identifiers.v,
              name: identifiers.schemas.optional,
            }),
            parameters: [pipesToExpression(pipes), callParameter],
          }),
        ];
      }
    }

    if (optional && !callParameter) {
      pipes = [
        compiler.callExpression({
          functionName: compiler.propertyAccessExpression({
            expression: identifiers.v,
            name: identifiers.schemas.optional,
          }),
          parameters: [pipesToExpression(pipes)],
        }),
      ];
    }
  }

  // emit nodes only if $ref points to a reusable component
  if (identifier && identifier.name && identifier.created) {
    const statement = compiler.constVariable({
      comment: plugin.config.comments
        ? createSchemaComment({ schema })
        : undefined,
      exportConst: true,
      expression: pipesToExpression(pipes),
      name: identifier.name,
      typeName: state.hasCircularReference
        ? (compiler.propertyAccessExpression({
            expression: identifiers.v,
            name: anyType || identifiers.types.GenericSchema.text,
          }) as unknown as ts.TypeNode)
        : undefined,
    });
    file.add(statement);

    return [];
  }

  return pipes;
};

export const handler: ValibotPlugin['Handler'] = ({ plugin }) => {
  const file = plugin.createFile({
    case: plugin.config.case,
    id: valibotId,
    path: plugin.output,
  });

  file.import({
    alias: identifiers.v.text,
    module: 'valibot',
    name: '*',
  });

  plugin.forEach('operation', 'parameter', 'requestBody', 'schema', (event) => {
    const state: State = {
      circularReferenceTracker: new Set(),
      hasCircularReference: false,
      nameCase: plugin.config.definitions.case,
      nameTransformer: plugin.config.definitions.name,
    };

    if (event.type === 'operation') {
      operationToValibotSchema({
        operation: event.operation,
        plugin,
        state,
      });
    } else if (event.type === 'parameter') {
      schemaToValibotSchema({
        $ref: event.$ref,
        plugin,
        schema: event.parameter.schema,
        state,
      });
    } else if (event.type === 'requestBody') {
      schemaToValibotSchema({
        $ref: event.$ref,
        plugin,
        schema: event.requestBody.schema,
        state,
      });
    } else if (event.type === 'schema') {
      schemaToValibotSchema({
        $ref: event.$ref,
        plugin,
        schema: event.schema,
        state,
      });
    }
  });
};
