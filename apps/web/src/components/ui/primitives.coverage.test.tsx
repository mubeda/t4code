// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardFrame,
  CardFrameDescription,
  CardFrameFooter,
  CardFrameHeader,
  CardFrameTitle,
  CardHeader,
  CardPanel,
  CardTitle,
} from "./card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./empty";
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldItem,
  FieldLabel,
  FieldValidity,
} from "./field";
import { Fieldset, FieldsetLegend } from "./fieldset";
import { Form } from "./form";
import { Group, GroupSeparator, GroupText } from "./group";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "./input-group";
import { Kbd, KbdGroup } from "./kbd";
import { Label } from "./label";
import {
  CursorGrowIcon,
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
  NumberFieldScrubArea,
} from "./number-field";
import { Radio, RadioGroup } from "./radio-group";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";
import { Toggle, ToggleGroup, ToggleGroupSeparator } from "./toggle-group";

describe("UI primitive composition", () => {
  it("classifies alert children and preserves every semantic slot", () => {
    const variants = ["default", "error", "info", "success", "warning"] as const;
    const markup = renderToStaticMarkup(
      <>
        {variants.map((variant) => (
          <Alert className={`alert-${variant}`} key={variant} variant={variant}>
            plain content
            <svg aria-label={`${variant} icon`} />
            <AlertTitle>{variant} title</AlertTitle>
            <AlertDescription>{variant} description</AlertDescription>
            <AlertAction>{variant} action</AlertAction>
            <span data-slot="alert-description">slotted description</span>
          </Alert>
        ))}
      </>,
    );

    expect(markup.match(/role="alert"/gu)).toHaveLength(variants.length);
    expect(markup).toContain("data-slot=\"alert-action\"");
    expect(markup).toContain("alert-warning");
    expect(markup).toContain("warning icon");
  });

  it("renders the complete card and table structures with caller classes", () => {
    const markup = renderToStaticMarkup(
      <>
        <CardFrame className="frame-custom">
          <CardFrameHeader>
            <CardFrameTitle>Frame title</CardFrameTitle>
            <CardFrameDescription>Frame description</CardFrameDescription>
          </CardFrameHeader>
          <Card className="card-custom">
            <CardHeader>
              <CardTitle>Card title</CardTitle>
              <CardDescription>Card description</CardDescription>
              <CardAction>Action</CardAction>
            </CardHeader>
            <CardPanel>Panel</CardPanel>
            <CardFooter>Footer</CardFooter>
          </Card>
          <CardFrameFooter>Frame footer</CardFrameFooter>
        </CardFrame>
        <Table className="table-custom">
          <TableCaption>Caption</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Header</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Footer</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </>,
    );

    expect(markup).toContain("data-slot=\"card-frame\"");
    expect(markup).toContain("frame-custom");
    expect(markup).toContain("data-slot=\"card-panel\"");
    expect(markup).toContain("data-slot=\"table-container\"");
    expect(markup).toContain("table-custom");
  });

  it("renders empty, input-group, number-field, and toggle variants", () => {
    const markup = renderToStaticMarkup(
      <>
        <Empty className="empty-custom">
          <EmptyHeader>
            <EmptyMedia variant="default">Default media</EmptyMedia>
            <EmptyMedia className="icon-media" variant="icon">
              Icon media
            </EmptyMedia>
            <EmptyTitle>Nothing here</EmptyTitle>
            <EmptyDescription>Description</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>Content</EmptyContent>
        </Empty>
        <InputGroup>
          {(["inline-start", "inline-end", "block-start", "block-end"] as const).map((align) => (
            <InputGroupAddon align={align} key={align}>
              <InputGroupText>{align}</InputGroupText>
            </InputGroupAddon>
          ))}
          <InputGroupInput aria-label="Grouped input" />
          <InputGroupTextarea aria-label="Grouped textarea" />
        </InputGroup>
        <NumberField className="number-custom" defaultValue={2} id="copies" size="sm">
          <NumberFieldScrubArea label="Copies" />
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
        <NumberField defaultValue={1} size="lg">
          <NumberFieldGroup>
            <NumberFieldInput />
          </NumberFieldGroup>
        </NumberField>
        <CursorGrowIcon className="cursor-custom" />
        <ToggleGroup>
          <Toggle value="one">One</Toggle>
          <ToggleGroupSeparator />
          <Toggle size="lg" value="two" variant="outline">
            Two
          </Toggle>
        </ToggleGroup>
        <ToggleGroup orientation="vertical" variant="outline">
          <Toggle value="three">Three</Toggle>
          <ToggleGroupSeparator orientation="horizontal" />
        </ToggleGroup>
      </>,
    );

    expect(markup).toContain("empty-custom");
    expect(markup).toContain("data-align=\"block-end\"");
    expect(markup).toContain("id=\"copies\"");
    expect(markup).toContain("cursor-custom");
    expect(markup).toContain("data-slot=\"toggle-group\"");
    expect(markup).toContain("data-orientation=\"vertical\"");
  });

  it("rejects an accessible scrub label outside its number field", () => {
    expect(() => renderToStaticMarkup(<NumberFieldScrubArea label="Copies" />)).toThrowError(
      /must be used within a NumberField/u,
    );
  });

  it("composes field, form, grouping, keyboard, and radio semantics", () => {
    const markup = renderToStaticMarkup(
      <Form className="form-custom">
        <Fieldset className="fieldset-custom">
          <FieldsetLegend>Preferences</FieldsetLegend>
          <Field className="field-custom" name="nickname">
            <FieldLabel>Nickname</FieldLabel>
            <FieldControl render={<input defaultValue="Ada" />} />
            <FieldItem>Item</FieldItem>
            <FieldDescription>Public display name</FieldDescription>
            <FieldError match>Required</FieldError>
            <FieldValidity>{() => <span>validity</span>}</FieldValidity>
          </Field>
        </Fieldset>
        <Group orientation="horizontal">
          <GroupText>Horizontal</GroupText>
          <GroupSeparator />
        </Group>
        <Group className="vertical-group" orientation="vertical">
          <GroupText render={<span />}>Vertical</GroupText>
          <GroupSeparator orientation="horizontal" />
        </Group>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
        <Label htmlFor="choice-a">Choice</Label>
        <RadioGroup defaultValue="a" name="choice">
          <Radio id="choice-a" value="a" />
          <Radio value="b" />
        </RadioGroup>
      </Form>,
    );

    expect(markup).toContain("data-slot=\"form\"");
    expect(markup).toContain("data-slot=\"fieldset-legend\"");
    expect(markup).toContain("name=\"nickname\"");
    expect(markup).toContain("data-orientation=\"vertical\"");
    expect(markup).toContain("data-slot=\"kbd\"");
    expect(markup).toContain("id=\"choice-a\"");
  });
});
