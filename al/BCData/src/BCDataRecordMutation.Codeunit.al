codeunit 99104 "BCD Record Mutation"
{
    Access = Internal;
    // Internal primitive only. The receipt coordinator must anchor the transaction
    // before entering user validation/triggers. No service/MCP write exposes it yet.
    [CommitBehavior(CommitBehavior::Error)]
    procedure Execute(Input: Text): Text
    var
        Request: JsonObject;
        Response: JsonObject;
        Values: JsonObject;
        Assignments: JsonArray;
        Token: JsonToken;
        Item: JsonObject;
        Metadata: Record "Table Metadata";
        TableRef: RecordRef;
        ValueField: FieldRef;
        PrimaryKey: KeyRef;
        KeyValues: array[16] of Variant;
        Selected: List of [Integer];
        Decoder: Codeunit "BCD Field Input";
        Service: Codeunit "BCD Data Service";
        Operation: Text;
        Output: Text;
        VersionText: Text;
        OriginalPosition: Text;
        TargetId: Guid;
        ActualId: Guid;
        ExpectedVersion: BigInteger;
        ActualVersion: BigInteger;
        TableId: Integer;
        FieldId: Integer;
        Index: Integer;
        KeyIndex: Integer;
        Decoded: Variant;
        Name: Text;
    begin
        if (StrLen(Input) > 32768) or not Request.ReadFrom(Input) then
            Error('BCD_INVALID_INPUT: mutation JSON exceeds 32768 characters or is invalid.');
        foreach Name in Request.Keys() do
            if not (Name in ['operation', 'tableId', 'systemId', 'expectedVersion', 'fields', 'primaryKey']) then
                Error('BCD_INVALID_INPUT: unexpected mutation property %1.', Name);
        Token := Required(Request, 'operation');
        Operation := Decoder.RequireString(Token);
        if not (Operation in ['insert', 'modify', 'delete', 'rename']) then
            Error('BCD_INVALID_INPUT: unsupported mutation operation.');
        Token := Required(Request, 'tableId');
        TableId := Token.AsValue().AsInteger();
        Token.WriteTo(Output);
        if Format(TableId, 0, 9) <> Output then
            Error('BCD_INVALID_INPUT: tableId must be an integer JSON number.');
        if (TableId <= 0) or (TableId >= 2000000000) then
            Error('BCD_UNSUPPORTED_TABLE: physical application tables only.');
        Metadata.Get(TableId);
        if TableId = Database::"BCD Mutation Receipt" then
            Error('BCD_UNSUPPORTED_TABLE: companion request state cannot be a mutation target.');
        if (Metadata.TableType <> Metadata.TableType::Normal) or not Metadata.DataPerCompany then
            Error('BCD_UNSUPPORTED_TABLE: company-local physical Normal table required.');
        if CompanyName() = '' then
            Error('BCD_INVALID_INPUT: explicit company context required.');
        TableRef.Open(TableId, false, CompanyName());
        TableRef.SecurityFiltering(SecurityFilter::Filtered);
        PrimaryKey := TableRef.KeyIndex(1);
        if Operation = 'insert' then begin
            if Request.Contains('expectedVersion') or Request.Contains('systemId') then
                Error('BCD_INVALID_INPUT: insert identity is server-generated and has no expectedVersion.');
            TableRef.Init();
        end else begin
            TargetId := ReadGuid(Decoder.RequireString(Required(Request, 'systemId')));
            VersionText := Decoder.RequireString(Required(Request, 'expectedVersion'));
            if not Evaluate(ExpectedVersion, VersionText, 9) then
                Error('BCD_INVALID_INPUT: invalid expectedVersion.');
            if (ExpectedVersion <= 0) or (Format(ExpectedVersion, 0, 9) <> VersionText) then
                Error('BCD_INVALID_INPUT: canonical positive expectedVersion string required.');
            // Locked reread and comparison share the mutation transaction.
            TableRef.LockTable();
            if not TableRef.GetBySystemId(TargetId) then
                Error('BCD_RECORD_NOT_FOUND: target is absent or not visible.');
            ValueField := TableRef.Field(0);
            ActualVersion := ValueField.Value;
            if ActualVersion <> ExpectedVersion then
                Error('BCD_CONCURRENCY_CONFLICT: target changed since the supplied version.');
            OriginalPosition := TableRef.GetPosition(false);
        end;

        if Operation in ['insert', 'modify'] then begin
            if Request.Contains('primaryKey') then
                Error('BCD_INVALID_INPUT: primaryKey is only valid for rename.');
            Token := Required(Request, 'fields');
            Assignments := Token.AsArray();
            if (Assignments.Count() < 1) or (Assignments.Count() > 50) then
                Error('BCD_INVALID_INPUT: supply 1 to 50 ordered fields.');
            // Validate the entire shape/types before any user field trigger.
            foreach Token in Assignments do begin
                Item := Token.AsObject();
                FieldId := AssignmentField(Item);
                if Selected.Contains(FieldId) then
                    Error('BCD_INVALID_INPUT: duplicate field %1.', FieldId);
                CheckField(TableRef, FieldId);
                if Operation = 'modify' then
                    for KeyIndex := 1 to PrimaryKey.FieldCount() do begin
                        ValueField := PrimaryKey.FieldIndex(KeyIndex);
                        if ValueField.Number() = FieldId then
                            Error('BCD_INVALID_INPUT: use rename for primary-key changes.');
                    end;
                ValueField := TableRef.Field(FieldId);
                Decoded := Decoder.Decode(ValueField, Required(Item, 'value'));
                Selected.Add(FieldId);
            end;
            foreach Token in Assignments do begin
                Item := Token.AsObject();
                FieldId := AssignmentField(Item);
                ValueField := TableRef.Field(FieldId);
                Decoded := Decoder.Decode(ValueField, Required(Item, 'value'));
                ValueField.Validate(Decoded);
                if (Operation = 'modify') and (TableRef.GetPosition(false) <> OriginalPosition) then
                    Error('BCD_INVALID_INPUT: validation changed the primary key; use rename.');
            end;
            if Operation = 'insert' then
                TableRef.Insert(true)
            else
                TableRef.Modify(true);
            if (Operation = 'modify') and (TableRef.GetPosition(false) <> OriginalPosition) then
                Error('BCD_INVALID_INPUT: modify trigger changed the primary key; use rename.');
        end else begin
            if Request.Contains('fields') then
                Error('BCD_INVALID_INPUT: fields are only valid for insert/modify.');
            if Operation = 'delete' then begin
                if Request.Contains('primaryKey') then
                    Error('BCD_INVALID_INPUT: delete cannot specify primaryKey.');
                TableRef.Delete(true);
            end else begin
                Token := Required(Request, 'primaryKey');
                Assignments := Token.AsArray();
                if (Assignments.Count() <> PrimaryKey.FieldCount()) or (Assignments.Count() > 16) then
                    Error('BCD_INVALID_INPUT: rename requires every primary-key field in key order (maximum 16).');
                for Index := 1 to Assignments.Count() do begin
                    Assignments.Get(Index - 1, Token);
                    Item := Token.AsObject();
                    FieldId := AssignmentField(Item);
                    ValueField := PrimaryKey.FieldIndex(Index);
                    if FieldId <> ValueField.Number() then
                        Error('BCD_INVALID_INPUT: rename primary-key order mismatch.');
                    CheckField(TableRef, FieldId);
                    KeyValues[Index] := Decoder.Decode(ValueField, Required(Item, 'value'));
                    Selected.Add(FieldId);
                end;
                RenameRecord(TableRef, KeyValues, Assignments.Count());
            end;
        end;

        Response.Add('operation', Operation);
        Response.Add('tableId', TableId);
        Response.Add('outcome', 'applied');
        if Operation = 'delete' then begin
            Response.Add('systemId', LowerCase(Format(TargetId, 0, 4)));
            // Minimal acknowledgement: no historical row values or fictitious version.
        end else begin
            ValueField := TableRef.Field(TableRef.SystemIdNo());
            ActualId := ValueField.Value;
            if not TableRef.GetBySystemId(ActualId) then
                Error('BCD_RECORD_NOT_FOUND: resulting record is absent or not visible.');
            ValueField := TableRef.Field(0);
            ActualVersion := ValueField.Value;
            Response.Add('systemId', LowerCase(Format(ActualId, 0, 4)));
            Response.Add('version', Format(ActualVersion, 0, 9));
            foreach FieldId in Selected do begin
                ValueField := TableRef.Field(FieldId);
                Service.AddValue(Values, Format(FieldId, 0, 9), ValueField);
            end;
            Response.Add('values', Values);
        end;
        TableRef.Close();
        Response.WriteTo(Output);
        if StrLen(Output) > 262144 then
            Error('BCD_RESPONSE_TOO_LARGE: mutation result exceeds the response bound.');
        exit(Output);
    end;

    local procedure Required(ObjectValue: JsonObject; Name: Text): JsonToken
    var
        Token: JsonToken;
    begin
        if not ObjectValue.Get(Name, Token) then
            Error('BCD_INVALID_INPUT: missing %1.', Name);
        exit(Token);
    end;

    local procedure AssignmentField(Item: JsonObject): Integer
    var
        Token: JsonToken;
        FieldId: Integer;
        TextValue: Text;
    begin
        if (Item.Keys().Count() <> 2) or not Item.Contains('value') then
            Error('BCD_INVALID_INPUT: field assignment requires fieldId and value only.');
        Token := Required(Item, 'fieldId');
        FieldId := Token.AsValue().AsInteger();
        Token.WriteTo(TextValue);
        if Format(FieldId, 0, 9) <> TextValue then
            Error('BCD_INVALID_INPUT: fieldId must be an integer JSON number.');
        exit(FieldId);
    end;

    local procedure CheckField(var TableRef: RecordRef; FieldId: Integer)
    var
        ValueField: FieldRef;
    begin
        if (FieldId <= 0) or (FieldId >= 2000000000) or not TableRef.FieldExist(FieldId) then
            Error('BCD_INVALID_INPUT: unknown or system-managed field %1.', FieldId);
        ValueField := TableRef.Field(FieldId);
        if not ValueField.Active() then
            Error('BCD_INVALID_INPUT: inactive field %1.', FieldId);
        if ValueField.Class <> FieldClass::Normal then
            Error('BCD_UNSUPPORTED_FIELD: FlowField/FlowFilter writes require a separately qualified path.');
    end;

    local procedure ReadGuid(Value: Text): Guid
    var
        Result: Guid;
    begin
        if (StrLen(Value) <> 36) or not Evaluate(Result, Value) then
            Error('BCD_INVALID_INPUT: target systemId must be a GUID.');
        if IsNullGuid(Result) or (LowerCase(Format(Result, 0, 4)) <> LowerCase(Value)) then
            Error('BCD_INVALID_INPUT: target systemId must be a nonzero GUID.');
        exit(Result);
    end;

    local procedure RenameRecord(var TableRef: RecordRef; KeyValues: array[16] of Variant; Count: Integer)
    begin
        // Native Rename invokes OnRename and relation behavior; no Delete/Insert emulation.
        case Count of
            1: TableRef.Rename(KeyValues[1]);
            2: TableRef.Rename(KeyValues[1], KeyValues[2]);
            3: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3]);
            4: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4]);
            5: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5]);
            6: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6]);
            7: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7]);
            8: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7], KeyValues[8]);
            9: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7], KeyValues[8], KeyValues[9]);
            10: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7], KeyValues[8], KeyValues[9], KeyValues[10]);
            11: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7], KeyValues[8], KeyValues[9], KeyValues[10], KeyValues[11]);
            12: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7], KeyValues[8], KeyValues[9], KeyValues[10], KeyValues[11], KeyValues[12]);
            13: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7], KeyValues[8], KeyValues[9], KeyValues[10], KeyValues[11], KeyValues[12], KeyValues[13]);
            14: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7], KeyValues[8], KeyValues[9], KeyValues[10], KeyValues[11], KeyValues[12], KeyValues[13], KeyValues[14]);
            15: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7], KeyValues[8], KeyValues[9], KeyValues[10], KeyValues[11], KeyValues[12], KeyValues[13], KeyValues[14], KeyValues[15]);
            16: TableRef.Rename(KeyValues[1], KeyValues[2], KeyValues[3], KeyValues[4], KeyValues[5], KeyValues[6], KeyValues[7], KeyValues[8], KeyValues[9], KeyValues[10], KeyValues[11], KeyValues[12], KeyValues[13], KeyValues[14], KeyValues[15], KeyValues[16]);
            else Error('BCD_INVALID_INPUT: unsupported primary-key arity.');
        end;
    end;
}
