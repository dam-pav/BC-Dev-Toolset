codeunit 99105 "BCD Field Input"
{
    Access = Internal;
    // Decode only: native FieldRef.Validate applies the value at the ordered step.
    procedure Decode(ValueField: FieldRef; Token: JsonToken): Variant
    var
        TextValue: Text;
        Encoded: Text;
        IntValue: Integer;
        LargeValue: BigInteger;
        DecimalValue: Decimal;
        GuidValue: Guid;
        DateValue: Date;
        TimeValue: Time;
        DateTimeValue: DateTime;
        ObjectValue: JsonObject;
        ClosingToken: JsonToken;
        Index: Integer;
        Found: Boolean;
    begin
        if not Token.IsValue() then begin
            if (ValueField.Type = FieldType::Date) and Token.IsObject() then begin
                ObjectValue := Token.AsObject();
                if (ObjectValue.Keys().Count() <> 2) or not ObjectValue.Get('date', ClosingToken) then
                    Error('BCD_INVALID_INPUT: closing date requires date and closing.');
                DateValue := ParseDate(RequireString(ClosingToken));
                if not ObjectValue.Get('closing', ClosingToken) then
                    Error('BCD_INVALID_INPUT: closing date requires closing=true.');
                ClosingToken.WriteTo(Encoded);
                if (Encoded <> 'true') or (DateValue = 0D) then
                    Error('BCD_INVALID_INPUT: closing date requires a date and closing=true.');
                exit(ClosingDate(DateValue));
            end;
            Error('BCD_INVALID_INPUT: scalar value required for field %1.', ValueField.Number());
        end;
        if Token.AsValue().IsNull() or Token.AsValue().IsUndefined() then
            Error('BCD_INVALID_INPUT: null is not a field-clearing instruction.');
        case ValueField.Type of
            FieldType::Text, FieldType::Code:
                begin
                    TextValue := RequireString(Token);
                    if StrLen(TextValue) > ValueField.Length() then
                        Error('BCD_INVALID_INPUT: value exceeds field %1 length.', ValueField.Number());
                    exit(TextValue);
                end;
            FieldType::Integer, FieldType::Option:
                begin
                    Token.WriteTo(Encoded);
                    IntValue := Token.AsValue().AsInteger();
                    if Format(IntValue, 0, 9) <> Encoded then
                        Error('BCD_INVALID_INPUT: integer JSON number required.');
                    if ValueField.Type = FieldType::Option then
                        if ValueField.IsEnum() then begin
                            for Index := 1 to ValueField.EnumValueCount() do
                                Found := Found or (ValueField.GetEnumValueOrdinal(Index) = IntValue);
                            if not Found then
                                Error('BCD_INVALID_INPUT: unknown enum ordinal.');
                        end else
                            if (IntValue < 0) or (IntValue >= ValueField.OptionMembers().Split(',').Count()) then
                                Error('BCD_INVALID_INPUT: unknown option ordinal.');
                    exit(IntValue);
                end;
            FieldType::BigInteger:
                begin
                    TextValue := RequireString(Token);
                    if not Evaluate(LargeValue, TextValue, 9) then
                        Error('BCD_INVALID_INPUT: invalid BigInteger.');
                    if Format(LargeValue, 0, 9) <> TextValue then
                        Error('BCD_INVALID_INPUT: canonical BigInteger string required.');
                    exit(LargeValue);
                end;
            FieldType::Decimal:
                begin
                    TextValue := RequireString(Token);
                    CheckDecimal(TextValue);
                    if not Evaluate(DecimalValue, TextValue, 9) then
                        Error('BCD_INVALID_INPUT: Decimal outside native range.');
                    exit(DecimalValue);
                end;
            FieldType::Boolean:
                begin
                    Token.WriteTo(Encoded);
                    if not (Encoded in ['true', 'false']) then
                        Error('BCD_INVALID_INPUT: JSON boolean required.');
                    exit(Token.AsValue().AsBoolean());
                end;
            FieldType::Guid:
                begin
                    TextValue := RequireString(Token);
                    if (StrLen(TextValue) <> 36) or not Evaluate(GuidValue, TextValue) then
                        Error('BCD_INVALID_INPUT: GUID string required.');
                    if LowerCase(Format(GuidValue, 0, 4)) <> LowerCase(TextValue) then
                        Error('BCD_INVALID_INPUT: GUID string required.');
                    exit(GuidValue);
                end;
            FieldType::Date:
                exit(ParseDate(RequireString(Token)));
            FieldType::Time:
                begin
                    TextValue := RequireString(Token);
                    if TextValue = '' then
                        exit(0T);
                    if (StrLen(TextValue) <> 12) or (CopyStr(TextValue, 3, 1) <> ':') or
                       (CopyStr(TextValue, 6, 1) <> ':') or (CopyStr(TextValue, 9, 1) <> '.') then
                        Error('BCD_INVALID_INPUT: Time requires HH:mm:ss.fff.');
                    if not Evaluate(TimeValue, TextValue, 9) then
                        Error('BCD_INVALID_INPUT: invalid Time.');
                    exit(TimeValue);
                end;
            FieldType::DateTime:
                begin
                    TextValue := RequireString(Token);
                    if TextValue = '' then
                        exit(0DT);
                    if (StrLen(TextValue) <> 24) or (CopyStr(TextValue, 11, 1) <> 'T') or
                       (CopyStr(TextValue, 20, 1) <> '.') or (CopyStr(TextValue, 24, 1) <> 'Z') then
                        Error('BCD_INVALID_INPUT: DateTime requires UTC YYYY-MM-DDTHH:mm:ss.fffZ.');
                    if not Evaluate(DateTimeValue, TextValue, 9) then
                        Error('BCD_INVALID_INPUT: invalid DateTime.');
                    exit(DateTimeValue);
                end;
            else
                Error('BCD_UNSUPPORTED_TYPE: field %1 is not writable through this scalar path.', ValueField.Number());
        end;
    end;

    procedure RequireString(Token: JsonToken): Text
    var
        Encoded: Text;
    begin
        if not Token.IsValue() then
            Error('BCD_INVALID_INPUT: JSON string required.');
        Token.WriteTo(Encoded);
        if CopyStr(Encoded, 1, 1) <> '"' then
            Error('BCD_INVALID_INPUT: JSON string required.');
        exit(Token.AsValue().AsText());
    end;

    local procedure ParseDate(Value: Text): Date
    var
        Result: Date;
    begin
        if Value = '' then
            exit(0D);
        if not Evaluate(Result, Value, 9) then
            Error('BCD_INVALID_INPUT: invalid Date.');
        if (StrLen(Value) <> 10) or (Format(Result, 0, 9) <> Value) then
            Error('BCD_INVALID_INPUT: Date requires YYYY-MM-DD.');
        exit(Result);
    end;

    local procedure CheckDecimal(Value: Text)
    var
        Index: Integer;
        Start: Integer;
        Dot: Boolean;
        Digit: Boolean;
        Character: Text[1];
    begin
        Start := 1;
        if CopyStr(Value, 1, 1) = '-' then
            Start := 2;
        for Index := Start to StrLen(Value) do begin
            Character := CopyStr(Value, Index, 1);
            if Character = '.' then begin
                if Dot or not Digit or (Index = StrLen(Value)) then
                    Error('BCD_INVALID_INPUT: invariant Decimal string required.');
                Dot := true;
            end else begin
                if StrPos('0123456789', Character) = 0 then
                    Error('BCD_INVALID_INPUT: invariant Decimal string required.');
                Digit := true;
            end;
        end;
        if not Digit then
            Error('BCD_INVALID_INPUT: invariant Decimal string required.');
    end;
}
