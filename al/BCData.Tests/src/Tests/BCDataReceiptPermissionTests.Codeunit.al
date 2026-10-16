using System.TestLibraries.Security.AccessControl;

codeunit 50207 "BCD Receipt Permission Tests"
{
    Subtype = Test;
    TestPermissions = Restrictive;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure MissingReceiptInsertDoesNotMutateCounter()
    var
        RunId: Guid;
        RequestId: Guid;
    begin
        Initialize(RunId, RequestId, false);
        PermissionsMock.Set('BCD RECEIPT NONE');
        asserterror Probe.Execute(Request(RunId, RequestId, 4));
        Assert.ExpectedError('BCD Receipt Fixture');
        CheckAndClean(RunId, 0);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure LostModifyAllowsHistoricalReplayButRejectsNewMutation()
    var
        RunId: Guid;
        RequestId: Guid;
        OriginalResult: Text;
    begin
        Initialize(RunId, RequestId, true);
        OriginalResult := Probe.Execute(Request(RunId, RequestId, 4));
        PermissionsMock.Set('BCD RECEIPT RUN R');
        Assert.AreEqual(OriginalResult, Probe.Execute(Request(RunId, RequestId, 4)), 'Historical replay under current read rights.');
        asserterror Probe.Execute(Request(RunId, CreateGuid(), 4));
        Assert.ExpectedError('BCD Receipt Run');
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'modify') > 0, 'New counter mutation must need Modify permission.');
        CheckAndClean(RunId, 1);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ReceiptReadAloneCannotReplayInsertFirstProtocol()
    var
        RunId: Guid;
        RequestId: Guid;
    begin
        Initialize(RunId, RequestId, true);
        PermissionsMock.Set('BCD RECEIPT R');
        asserterror Probe.Execute(Request(RunId, RequestId, 4));
        Assert.ExpectedError('BCD Receipt Fixture');
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'insert') > 0, 'Insert-first replay still needs receipt Insert permission.');
        CheckAndClean(RunId, 1);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure MissingCounterReadCannotRevealReplayResult()
    var
        RunId: Guid;
        RequestId: Guid;
    begin
        Initialize(RunId, RequestId, true);
        PermissionsMock.Set('BCD RECEIPT NO RUN R');
        asserterror Probe.Execute(Request(RunId, RequestId, 4));
        Assert.ExpectedError('BCD Receipt Run');
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'read') > 0, 'Replay must first read the owned run.');
        CheckAndClean(RunId, 1);
    end;

    local procedure Initialize(var RunId: Guid; var RequestId: Guid; ApplyFirst: Boolean)
    begin
        if PermissionsMock.IsStarted() then
            PermissionsMock.Stop();
        PermissionsMock.Start();
        PermissionsMock.Set('BCD RECEIPT SETUP');
        RunId := CreateGuid();
        RequestId := CreateGuid();
        Probe.Prepare(RunRequest(RunId));
        if ApplyFirst then
            Probe.Execute(Request(RunId, RequestId, 4));
        Commit();
    end;

    local procedure CheckAndClean(RunId: Guid; Applies: Integer)
    var
        State: JsonObject;
        Token: JsonToken;
    begin
        PermissionsMock.Set('BCD RECEIPT SETUP');
        State.ReadFrom(Probe.Inspect(RunRequest(RunId)));
        State.Get('applyCount', Token);
        Assert.AreEqual(Applies, Token.AsValue().AsInteger(), 'Denial must not add an apply.');
        State.Get('receiptCount', Token);
        Assert.AreEqual(Applies, Token.AsValue().AsInteger(), 'Denial must not leave a receipt.');
        State.Get('total', Token);
        Assert.AreEqual(Applies * 4, Token.AsValue().AsInteger(), 'Counter stays unchanged.');
        Probe.Cleanup(RunRequest(RunId));
        PermissionsMock.Stop();
    end;

    local procedure RunRequest(RunId: Guid): Text
    begin
        exit('{"runId":"' + Format(RunId, 0, 4) + '"}');
    end;

    local procedure Request(RunId: Guid; RequestId: Guid; Amount: Integer): Text
    var
        Input: JsonObject;
        Output: Text;
    begin
        Input.Add('runId', Format(RunId, 0, 4));
        Input.Add('requestId', Format(RequestId, 0, 4));
        Input.Add('amount', Amount);
        Input.WriteTo(Output);
        exit(Output);
    end;

    var
        PermissionsMock: Codeunit "Permissions Mock";
        Probe: Codeunit "BCD Receipt Probe";
        Assert: Codeunit "Library Assert";
}
