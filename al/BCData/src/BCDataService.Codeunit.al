codeunit 50100 "BCD Data Service"
{
    // No Permissions property: business-table access always uses the caller's rights.
    procedure Readiness(inputJson: Text): Text
    var
        Response: JsonObject;
        Capabilities: JsonArray;
    begin
        Capabilities.Add('companies');
        Capabilities.Add('table-search');
        Capabilities.Add('schema');
        Capabilities.Add('read-primary-key');
        Response.Add('contractVersion', 1);
        Response.Add('appVersion', '0.1.9.0');
        Response.Add('capabilities', Capabilities);
        Response.Add('mutationsEnabled', false);
        Response.Add('maxPageSize', 100);
        exit(Serialize(Response));
    end;

    procedure ListCompanies(inputJson: Text): Text
    var
        Company: Record Company;
        Response: JsonObject;
        Item: JsonObject;
        Items: JsonArray;
    begin
        if Company.FindSet() then
            repeat
                Clear(Item);
                Item.Add('id', LowerCase(Format(Company.Id, 0, 4)));
                Item.Add('name', Company.Name);
                Items.Add(Item);
            until Company.Next() = 0;
        Response.Add('companies', Items);
        exit(Serialize(Response));
    end;

    procedure FindTables(inputJson: Text): Text
    var
        Metadata: Record "Table Metadata";
        Request: JsonObject;
        Response: JsonObject;
        Item: JsonObject;
        Items: JsonArray;
        Query: Text;
        AfterId: Integer;
        Limit: Integer;
        LastId: Integer;
        HasMore: Boolean;
    begin
        Request.ReadFrom(inputJson);
        Query := LowerCase(GetText(Request, 'query'));
        if StrLen(Query) > 100 then
            Error('BCD_INVALID_INPUT: query exceeds 100 characters.');
        AfterId := GetInteger(Request, 'afterId', 0);
        Limit := GetInteger(Request, 'pageSize', 25);
        CheckLimit(Limit);
        if AfterId < 0 then
            Error('BCD_INVALID_INPUT: afterId must be nonnegative.');
        Metadata.SetFilter(ID, '>%1', AfterId);
        if Metadata.FindSet() then
            repeat
                if (Query = '') or (StrPos(LowerCase(Metadata.Name + ' ' + Metadata.Caption), Query) > 0) then
                    if Items.Count() < Limit then begin
                        Clear(Item);
                        Item.Add('id', Metadata.ID);
                        Item.Add('name', Metadata.Name);
                        Item.Add('caption', Metadata.Caption);
                        Item.Add('dataPerCompany', Metadata.DataPerCompany);
                        Item.Add('ordinaryReadSupported', (Metadata.TableType = Metadata.TableType::Normal) and (Metadata.ID < 2000000000));
                        Items.Add(Item);
                        LastId := Metadata.ID;
                    end else
                        HasMore := true;
            until (Metadata.Next() = 0) or HasMore;
        Response.Add('tables', Items);
        Response.Add('hasMore', HasMore);
        if HasMore then
            Response.Add('afterId', LastId);
        exit(Serialize(Response));
    end;

    procedure GetTableSchema(inputJson: Text): Text
    var
        Metadata: Record "Table Metadata";
        Request: JsonObject;
        Response: JsonObject;
        Item: JsonObject;
        Values: JsonArray;
        Fields: JsonArray;
        Keys: JsonArray;
        Members: JsonArray;
        Member: JsonObject;
        TableRef: RecordRef;
        ValueField: FieldRef;
        TableKey: KeyRef;
        Index: Integer;
        KeyIndex: Integer;
        MemberIndex: Integer;
        TableId: Integer;
    begin
        Request.ReadFrom(inputJson);
        TableId := GetInteger(Request, 'tableId', 0);
        OpenOrdinaryTable(TableId, TableRef);
        for Index := 1 to TableRef.FieldCount() do begin
            ValueField := TableRef.FieldIndex(Index);
            Clear(Item);
            Clear(Members);
            Item.Add('id', ValueField.Number());
            Item.Add('name', ValueField.Name());
            Item.Add('caption', ValueField.Caption());
            Item.Add('type', WireType(ValueField));
            Item.Add('class', WireClass(ValueField));
            Item.Add('length', ValueField.Length());
            Item.Add('systemManaged', (ValueField.Number() = 0) or (ValueField.Number() >= 2000000000));
            Item.Add('readSupportedInSlice', ReadSupported(ValueField));
            Item.Add('relationDetailsAvailable', false);
            Item.Add('obsoleteDetailsAvailable', false);
            if (ValueField.Type = FieldType::Option) and ValueField.IsEnum() then begin
                for MemberIndex := 1 to ValueField.EnumValueCount() do begin
                    Clear(Member);
                    Member.Add('ordinal', ValueField.GetEnumValueOrdinal(MemberIndex));
                    Member.Add('name', ValueField.GetEnumValueName(MemberIndex));
                    Member.Add('caption', ValueField.GetEnumValueCaption(MemberIndex));
                    Members.Add(Member);
                end;
                Item.Add('members', Members);
            end else
                if ValueField.Type = FieldType::Option then begin
                    Item.Add('optionMembers', ValueField.OptionMembers());
                    Item.Add('optionCaptions', ValueField.OptionCaption());
                end;
            Fields.Add(Item);
        end;
        for KeyIndex := 1 to TableRef.KeyCount() do begin
            TableKey := TableRef.KeyIndex(KeyIndex);
            Clear(Item);
            Clear(Values);
            for Index := 1 to TableKey.FieldCount() do begin
                ValueField := TableKey.FieldIndex(Index);
                Values.Add(ValueField.Number());
            end;
            Item.Add('primary', KeyIndex = 1);
            Item.Add('fieldIds', Values);
            Keys.Add(Item);
        end;
        Response.Add('tableId', TableId);
        Response.Add('name', TableRef.Name());
        Metadata.Get(TableId);
        Response.Add('dataPerCompany', Metadata.DataPerCompany);
        Response.Add('fields', Fields);
        Response.Add('keys', Keys);
        Response.Add('mutationsEnabled', false);
        TableRef.Close();
        exit(Serialize(Response));
    end;

    procedure ReadRecords(inputJson: Text): Text
    var
        Request: JsonObject;
        Response: JsonObject;
        Item: JsonObject;
        FieldValues: JsonObject;
        Items: JsonArray;
        Selected: JsonArray;
        Selection: JsonToken;
        TableRef: RecordRef;
        ValueField: FieldRef;
        SelectedIds: List of [Integer];
        Id: Integer;
        TableId: Integer;
        Limit: Integer;
        Position: Text;
        LastPosition: Text;
        Found: Boolean;
        RecordId: Guid;
        RowVersion: BigInteger;
    begin
        if CompanyName() = '' then
            Error('BCD_INVALID_INPUT: an explicit company context is required for record reads.');
        Request.ReadFrom(inputJson);
        TableId := GetInteger(Request, 'tableId', 0);
        Limit := GetInteger(Request, 'pageSize', 25);
        CheckLimit(Limit);
        OpenOrdinaryTable(TableId, TableRef);
        if not Request.Get('fieldIds', Selection) then
            Error('BCD_INVALID_INPUT: fieldIds is required.');
        Selected := Selection.AsArray();
        if (Selected.Count() = 0) or (Selected.Count() > 50) then
            Error('BCD_INVALID_INPUT: select between 1 and 50 fields.');
        foreach Selection in Selected do begin
            Id := Selection.AsValue().AsInteger();
            if SelectedIds.Contains(Id) then
                Error('BCD_INVALID_INPUT: duplicate field selection.');
            ValueField := TableRef.Field(Id);
            if ValueField.Class = FieldClass::FlowFilter then
                Error('BCD_INVALID_INPUT: FlowFilters belong in flowFilters.');
            SelectedIds.Add(Id);
        end;
        ApplyFilters(Request, 'filters', false, TableRef);
        ApplyFilters(Request, 'flowFilters', true, TableRef);
        TableRef.CurrentKeyIndex(1);
        TableRef.Ascending(true);
        Position := GetText(Request, 'position');
        if Position <> '' then begin
            TableRef.SetPosition(Position);
            Found := FindReadRecord(TableRef, true);
        end else
            Found := FindReadRecord(TableRef, false);
        while Found and (Items.Count() < Limit) do begin
            Clear(Item);
            Clear(FieldValues);
            ValueField := TableRef.Field(TableRef.SystemIdNo());
            RecordId := ValueField.Value;
            // Microsoft documents field 0 as the timestamp. Cross-version AL tests
            // verify its BigInteger value against the typed SystemRowVersion.
            ValueField := TableRef.Field(0);
            RowVersion := ValueField.Value;
            Item.Add('systemId', LowerCase(Format(RecordId, 0, 4)));
            Item.Add('version', Format(RowVersion, 0, 9));
            foreach Id in SelectedIds do begin
                ValueField := TableRef.Field(Id);
                if (ValueField.Class = FieldClass::FlowField) and (ValueField.Type <> FieldType::Blob) then
                    CalculateReadField(ValueField);
                AddValue(FieldValues, Format(Id, 0, 9), ValueField);
            end;
            Item.Add('values', FieldValues);
            Items.Add(Item);
            LastPosition := TableRef.GetPosition(false);
            Found := TableRef.Next() <> 0;
        end;
        Response.Add('tableId', TableId);
        Response.Add('records', Items);
        Response.Add('hasMore', Found);
        if Found then
            Response.Add('position', LastPosition);
        Response.Add('sort', 'primary-key-ascending');
        Response.Add('snapshot', false);
        Response.Add('flowFieldConcurrencyProtected', false);
        TableRef.Close();
        exit(Serialize(Response));
    end;

    local procedure FindReadRecord(var TableRef: RecordRef; AfterPosition: Boolean): Boolean
    var
        Found: Boolean;
    begin
        ClearLastError();
        if not TryFindReadRecord(TableRef, AfterPosition, Found) then
            RaiseReadError();
        exit(Found);
    end;

    [TryFunction]
    local procedure TryFindReadRecord(var TableRef: RecordRef; AfterPosition: Boolean; var Found: Boolean)
    begin
        if AfterPosition then
            Found := TableRef.Find('>')
        else
            Found := TableRef.FindFirst();
    end;

    local procedure CalculateReadField(var ValueField: FieldRef)
    begin
        ClearLastError();
        if not TryCalculateReadField(ValueField) then
            RaiseReadError();
    end;

    [TryFunction]
    local procedure TryCalculateReadField(var ValueField: FieldRef)
    begin
        ValueField.CalcField();
    end;

    local procedure RaiseReadError()
    var
        ErrorCode: Text;
        ErrorText: Text;
    begin
        ErrorCode := GetLastErrorCode();
        ErrorText := GetLastErrorText();
        // Measured on BC23/BC27.1. Match the untranslated identifier, not localized text.
        // These TryFunctions perform reads only and never retry with different rights.
        if ErrorCode = 'DB:ClientReadDenied' then
            Error('BCD_PERMISSION_DENIED: %1', ErrorText);
        Error('%1', ErrorText);
    end;

    local procedure OpenOrdinaryTable(TableId: Integer; var TableRef: RecordRef)
    var
        Metadata: Record "Table Metadata";
    begin
        if (TableId <= 0) or (TableId >= 2000000000) then
            Error('BCD_UNSUPPORTED_TABLE: ordinary application tables only.');
        Metadata.Get(TableId);
        if Metadata.TableType <> Metadata.TableType::Normal then
            Error('BCD_UNSUPPORTED_TABLE: physical Normal tables only.');
        TableRef.Open(TableId, false, CompanyName());
        // Apply security filters to the query, including look-ahead and FlowFields.
        // Validated (the default) fails when traversal encounters an inaccessible row.
        TableRef.SecurityFiltering(SecurityFilter::Filtered);
    end;

    local procedure ApplyFilters(Request: JsonObject; PropertyName: Text; IsFlowFilter: Boolean; var TableRef: RecordRef)
    var
        Token: JsonToken;
        Entries: JsonArray;
        Entry: JsonObject;
        Seen: List of [Integer];
        ValueField: FieldRef;
        Id: Integer;
    begin
        if not Request.Get(PropertyName, Token) then
            exit;
        Entries := Token.AsArray();
        if Entries.Count() > 50 then
            Error('BCD_INVALID_INPUT: too many filters.');
        foreach Token in Entries do begin
            Entry := Token.AsObject();
            Id := GetInteger(Entry, 'fieldId', 0);
            if Seen.Contains(Id) then
                Error('BCD_INVALID_INPUT: duplicate filter.');
            Seen.Add(Id);
            ValueField := TableRef.Field(Id);
            if (ValueField.Class = FieldClass::FlowFilter) <> IsFlowFilter then
                Error('BCD_INVALID_INPUT: incorrect filter group.');
            if StrLen(GetText(Entry, 'expression')) > 4000 then
                Error('BCD_INVALID_INPUT: filter expression exceeds 4000 characters.');
            ValueField.SetFilter(GetText(Entry, 'expression'));
        end;
    end;

    internal procedure AddValue(var Values: JsonObject; PropertyName: Text; ValueField: FieldRef)
    var
        IntegerValue: Integer;
        LargeIntegerValue: BigInteger;
        DecimalValue: Decimal;
        BooleanValue: Boolean;
        TextValue: Text;
        GuidValue: Guid;
        DateValue: Date;
        TimeValue: Time;
        DateTimeValue: DateTime;
        XmlValue: Text;
        Descriptor: JsonObject;
    begin
        case ValueField.Type of
            FieldType::Integer, FieldType::Option:
                begin
                    IntegerValue := ValueField.Value;
                    Values.Add(PropertyName, IntegerValue);
                end;
            FieldType::BigInteger:
                begin
                    LargeIntegerValue := ValueField.Value;
                    Values.Add(PropertyName, Format(LargeIntegerValue, 0, 9));
                end;
            FieldType::Decimal:
                begin
                    DecimalValue := ValueField.Value;
                    Values.Add(PropertyName, DecimalText(DecimalValue));
                end;
            FieldType::Boolean:
                begin
                    BooleanValue := ValueField.Value;
                    Values.Add(PropertyName, BooleanValue);
                end;
            FieldType::Text, FieldType::Code:
                begin
                    TextValue := ValueField.Value;
                    Values.Add(PropertyName, TextValue);
                end;
            FieldType::Guid:
                begin
                    GuidValue := ValueField.Value;
                    Values.Add(PropertyName, LowerCase(Format(GuidValue, 0, 4)));
                end;
            FieldType::Date:
                begin
                    DateValue := ValueField.Value;
                    if DateValue = 0D then
                        Values.Add(PropertyName, '')
                    else
                        if DateValue <> NormalDate(DateValue) then begin
                            Descriptor.Add('date', Format(NormalDate(DateValue), 0, 9));
                            Descriptor.Add('closing', true);
                            Values.Add(PropertyName, Descriptor);
                        end else
                            Values.Add(PropertyName, Format(DateValue, 0, 9));
                end;
            FieldType::Time:
                begin
                    TimeValue := ValueField.Value;
                    if TimeValue = 0T then
                        Values.Add(PropertyName, '')
                    else
                        Values.Add(PropertyName, MillisecondTime(Format(TimeValue, 0, 9)));
                end;
            FieldType::DateTime:
                begin
                    DateTimeValue := ValueField.Value;
                    if DateTimeValue = 0DT then
                        Values.Add(PropertyName, '')
                    else begin
                        // Standard XML format is UTC; do not construct from local DT2Date/DT2Time.
                        XmlValue := Format(DateTimeValue, 0, 9);
                        if (StrLen(XmlValue) < 20) or (CopyStr(XmlValue, StrLen(XmlValue), 1) <> 'Z') then
                            Error('BCD_UNSUPPORTED_TYPE: unexpected UTC DateTime encoding.');
                        Values.Add(PropertyName, CopyStr(XmlValue, 1, 11) +
                            MillisecondTime(CopyStr(XmlValue, 12, StrLen(XmlValue) - 12)) + 'Z');
                    end;
                end;
            FieldType::Blob, FieldType::Media, FieldType::MediaSet:
                begin
                    Descriptor.Add('type', WireType(ValueField));
                    Descriptor.Add('retrievalSupported', false);
                    Values.Add(PropertyName, Descriptor);
                end;
            else
                Error('BCD_UNSUPPORTED_TYPE: scalar encoding is not yet qualified for field %1.', ValueField.Number());
        end;
    end;

    local procedure DecimalText(Value: Decimal): Text
    var
        JsonNumber: JsonValue;
        NumberText: Text;
    begin
        // Format(..., 9) rounds stored values below 18 fractional places on BC23.
        // JSON numeric serialization is invariant and retains the Decimal value;
        // the outer value remains a string so JavaScript never parses its precision.
        JsonNumber.SetValue(Value);
        JsonNumber.WriteTo(NumberText);
        // Some runtimes represent Decimal JSON values as precision-preserving strings.
        if CopyStr(NumberText, 1, 1) = '"' then
            NumberText := JsonNumber.AsText();
        if (StrPos(NumberText, 'e') > 0) or (StrPos(NumberText, 'E') > 0) then
            Error('BCD_UNSUPPORTED_TYPE: unexpected Decimal exponent encoding.');
        if DelChr(NumberText, '=', '-0123456789.') <> '' then
            Error('BCD_UNSUPPORTED_TYPE: unexpected invariant Decimal encoding.');
        if StrPos(NumberText, '.') > 0 then begin
            while CopyStr(NumberText, StrLen(NumberText), 1) = '0' do
                NumberText := CopyStr(NumberText, 1, StrLen(NumberText) - 1);
            if CopyStr(NumberText, StrLen(NumberText), 1) = '.' then
                NumberText := CopyStr(NumberText, 1, StrLen(NumberText) - 1);
        end;
        if NumberText = '-0' then
            NumberText := '0';
        exit(NumberText);
    end;

    local procedure MillisecondTime(XmlTime: Text): Text
    begin
        // XML may omit zero fractional digits; the contract always carries three.
        if StrLen(XmlTime) = 8 then
            exit(XmlTime + '.000');
        if (StrLen(XmlTime) in [10, 11, 12]) and (CopyStr(XmlTime, 9, 1) = '.') then
            exit(PadStr(XmlTime, 12, '0'));
        Error('BCD_UNSUPPORTED_TYPE: unexpected millisecond Time encoding.');
    end;

    local procedure WireType(ValueField: FieldRef): Text
    begin
        if (ValueField.Type = FieldType::Option) and ValueField.IsEnum() then
            exit('Enum');
        case ValueField.Type of
            FieldType::Integer: exit('Integer');
            FieldType::BigInteger: exit('BigInteger');
            FieldType::Decimal: exit('Decimal');
            FieldType::Boolean: exit('Boolean');
            FieldType::Text: exit('Text');
            FieldType::Code: exit('Code');
            FieldType::Guid: exit('Guid');
            FieldType::Option: exit('Option');
            FieldType::Date: exit('Date');
            FieldType::Time: exit('Time');
            FieldType::DateTime: exit('DateTime');
            FieldType::Duration: exit('Duration');
            FieldType::DateFormula: exit('DateFormula');
            FieldType::RecordId: exit('RecordId');
            FieldType::Blob: exit('BLOB');
            FieldType::Media: exit('Media');
            FieldType::MediaSet: exit('MediaSet');
        end;
        exit('Unsupported');
    end;

    local procedure ReadSupported(ValueField: FieldRef): Boolean
    begin
        if ValueField.Class = FieldClass::FlowFilter then
            exit(false);
        exit(ValueField.Type in [FieldType::Integer, FieldType::BigInteger, FieldType::Decimal,
            FieldType::Boolean, FieldType::Text, FieldType::Code, FieldType::Guid, FieldType::Option,
            FieldType::Date, FieldType::Time, FieldType::DateTime,
            FieldType::Blob, FieldType::Media, FieldType::MediaSet]);
    end;

    local procedure WireClass(ValueField: FieldRef): Text
    begin
        case ValueField.Class of
            FieldClass::Normal: exit('Normal');
            FieldClass::FlowField: exit('FlowField');
            FieldClass::FlowFilter: exit('FlowFilter');
        end;
    end;

    local procedure GetInteger(Request: JsonObject; Name: Text; DefaultValue: Integer): Integer
    var
        Token: JsonToken;
    begin
        if Request.Get(Name, Token) then
            exit(Token.AsValue().AsInteger());
        exit(DefaultValue);
    end;

    local procedure GetText(Request: JsonObject; Name: Text): Text
    var
        Token: JsonToken;
    begin
        if Request.Get(Name, Token) then
            exit(Token.AsValue().AsText());
        exit('');
    end;

    local procedure CheckLimit(Limit: Integer)
    begin
        if (Limit < 1) or (Limit > 100) then
            Error('BCD_INVALID_INPUT: pageSize must be between 1 and 100.');
    end;

    local procedure Serialize(var Response: JsonObject): Text
    var
        Company: Record Company;
        Output: Text;
    begin
        // Connection-level readiness/company discovery can run before a company
        // is selected. Record reads require explicit context above.
        if CompanyName() <> '' then begin
            Company.Get(CompanyName());
            Response.Add('companyId', LowerCase(Format(Company.Id, 0, 4)));
        end else
            Response.Add('companyId', '');
        Response.Add('companyName', CompanyName());
        Response.WriteTo(Output);
        if StrLen(Output) > 262144 then
            Error('BCD_RESPONSE_TOO_LARGE: reduce selected fields or page size.');
        exit(Output);
    end;
}
