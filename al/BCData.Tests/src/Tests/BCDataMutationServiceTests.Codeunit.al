codeunit 50228 "BCD Mutation Service Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure UpgradeRegistersSeparateWriteService()
    var
        WebService: Record "Tenant Web Service";
    begin
        WebService.SetRange("Service Name", 'BCDDataWrite');
        Assert.IsTrue(WebService.FindFirst(), 'Upgrade must register the separate mutation service.');
        WebService.TestField("Object Type", WebService."Object Type"::Codeunit);
        WebService.TestField("Object ID", Codeunit::"BCD Mutation Service");
        WebService.TestField(Published, true);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure WriteRegistrationNeverReplacesAnotherObject()
    var
        WebService: Record "Tenant Web Service";
        Registration: Codeunit "BCD Service Registration";
    begin
        WebService.SetRange("Service Name", 'BCDDataWrite');
        WebService.FindFirst();
        WebService."Object ID" := Codeunit::"BCD Transport Probe";
        WebService.Modify();
        asserterror Registration.RegisterService();
        Assert.ExpectedError('BCD_REGISTRATION_CONFLICT');
        WebService.FindFirst();
        WebService.TestField("Object ID", Codeunit::"BCD Mutation Service");
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure PublicEnvelopeReplaysAndClosesPreparedCommand()
    var
        Row: Record "BCD Mutation Fixture";
        Receipt: Record "BCD Mutation Receipt";
        Request: JsonObject;
        Prepared: JsonObject;
        Envelope: JsonObject;
        Token: JsonToken;
        RequestId: Guid;
        RunId: Guid;
        Input: Text;
        ResultText: Text;
    begin
        RequestId := CreateGuid();
        RunId := CreateGuid();
        Input := '{"requestId":"' + Format(RequestId, 0, 4) + '"}';
        Prepared.ReadFrom(Service.Prepare(Input));
        Prepared.Get('companyId', Token);
        Assert.IsTrue(StrLen(Token.AsValue().AsText()) = 36, 'Wire response carries explicit company identity.');
        Envelope.Add('requestId', Format(RequestId, 0, 4));
        Prepared.Get('epoch', Token);
        Envelope.Add('epoch', Token);
        Request.ReadFrom('{"operation":"insert","tableId":50221,"fields":[{"fieldId":1,"value":"' +
            Format(RunId, 0, 4) + '"},{"fieldId":2,"value":"A"},{"fieldId":3,"value":1}]}');
        Envelope.Add('request', Request);
        Envelope.WriteTo(Input);
        ResultText := Service.Execute(Input);
        Assert.AreEqual(ResultText, Service.Execute(Input), 'Public replay returns exact result and company context.');
        Row.Get(RunId, 'A', 1);
        Row.TestField("Insert Count", 1);
        Envelope.Remove('request');
        Envelope.WriteTo(Input);
        Service.Close(Input);
        Receipt.Get(UserSecurityId(), RequestId);
        Receipt.TestField(Closed, true);
        Receipt.TestField(Completed, true);
        Envelope.Add('request', Request);
        Envelope.WriteTo(Input);
        asserterror Service.Execute(Input);
        Assert.ExpectedError('BCD_SCOPE_CLOSED');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure PublicEnvelopeRejectsUnexpectedOrInvalidInput()
    begin
        asserterror Service.Prepare('{"requestId":"00000000-0000-0000-0000-000000000000"}');
        Assert.ExpectedError('BCD_INVALID_INPUT');
        asserterror Service.Prepare('{"requestId":1}');
        Assert.ExpectedError('BCD_INVALID_INPUT');
        asserterror Service.Prepare('{"requestId":"not-a-guid","epoch":"caller-selected"}');
        Assert.ExpectedError('BCD_INVALID_INPUT');
        asserterror Service.Execute('{"requestId":"not-a-guid","epoch":"not-a-guid","request":[]}');
        Assert.ExpectedError('BCD_INVALID_INPUT');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure GenericReadsCannotExposeCompanionReceiptState()
    var
        ReadService: Codeunit "BCD Data Service";
        Response: JsonObject;
        Item: JsonObject;
        Tables: JsonArray;
        Token: JsonToken;
    begin
        Response.ReadFrom(ReadService.FindTables('{"query":"BCD Mutation Receipt","pageSize":1}'));
        Response.Get('tables', Token);
        Tables := Token.AsArray();
        Assert.AreEqual(1, Tables.Count(), 'Receipt metadata remains discoverable.');
        Tables.Get(0, Token);
        Item := Token.AsObject();
        Item.Get('ordinaryReadSupported', Token);
        Assert.IsFalse(Token.AsValue().AsBoolean(), 'Discovery must agree with the receipt read boundary.');
        asserterror ReadService.ReadRecords('{"tableId":50100,"fieldIds":[1,2,9],"pageSize":1}');
        Assert.ExpectedError('companion request state is not a record data target');
        asserterror ReadService.GetTableSchema('{"tableId":50100}');
        Assert.ExpectedError('companion request state is not a record data target');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ForegroundPurgeIsBoundedOwnedAndExpiredOnly()
    var
        Receipt: Record "BCD Mutation Receipt";
        ForeignReceipt: Record "BCD Mutation Receipt";
        Coordinator: Codeunit "BCD Mutation Coordinator";
        ActiveId: Guid;
        RequestId: Guid;
        Index: Integer;
    begin
        for Index := 1 to 67 do begin
            RequestId := CreateGuid();
            Coordinator.Prepare(RequestId);
            Receipt.Get(UserSecurityId(), RequestId);
            Receipt."Retry Until" := CurrentDateTime() - 1000;
            Receipt.Modify();
        end;
        ActiveId := CreateGuid();
        Coordinator.Prepare(ActiveId);
        Receipt.Get(UserSecurityId(), ActiveId);
        Coordinator.Close(ActiveId, Receipt.Epoch);
        ForeignReceipt.Principal := CreateGuid();
        ForeignReceipt."Request ID" := CreateGuid();
        ForeignReceipt.Epoch := CreateGuid();
        ForeignReceipt."Retry Until" := CurrentDateTime() - 1000;
        ForeignReceipt.Insert();
        Coordinator.PurgeExpiredOwned();
        Receipt.Reset();
        Receipt.SetRange(Principal, UserSecurityId());
        Receipt.SetFilter("Retry Until", '<%1', CurrentDateTime());
        Assert.AreEqual(3, Receipt.Count(), 'One preparation removes at most64 expired owned receipts.');
        Coordinator.PurgeExpiredOwned();
        Assert.IsTrue(Receipt.IsEmpty(), 'Later preparation can collect the remaining expired state.');
        Receipt.Reset();
        Receipt.Get(UserSecurityId(), ActiveId);
        Receipt.TestField(Closed, true);
        Assert.IsTrue(Receipt."Retry Until" > CurrentDateTime(), 'Closed history remains usable until its fixed deadline.');
        Assert.IsTrue(ForeignReceipt.Get(ForeignReceipt.Principal, ForeignReceipt."Request ID"), 'Another principal history is never purged.');
    end;

    var
        Service: Codeunit "BCD Mutation Service";
        Assert: Codeunit "Library Assert";
}
